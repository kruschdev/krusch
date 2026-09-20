import { KruschStateManager } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschCascadeRouter } from '../router/cascade.js';
import { ModelRegistry } from '../models/registry.js';
import { KruschTools } from '../tools/index.js';
import { KruschTrajectoryGuard } from './trajectory-guard.js';
import { KruschModularRSI } from './modular-rsi.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';
import { KruschFSM, HARNESS_PHASES } from './fsm.js';

export class KruschStateMachine {
  constructor(options = {}) {
    this.options = options;
    this.router = new KruschCascadeRouter(options);
    this.registry = new ModelRegistry(options);
    this.guard = new KruschTrajectoryGuard(options);
    this.policy = new KruschApprovalPolicy(options);
  }

  /**
   * Run a goal through the complete invariant coding harness lifecycle.
   */
  async runTask({ goal, projectPath = process.cwd(), maxTurns = 10, modelOverride = null }) {
    // 1. Initialize Task in PostgreSQL Cognitive Substrate
    const task = await KruschStateManager.createTask({
      goal,
      projectPath,
      phase: HARNESS_PHASES.INIT,
      metadata: { initiatedBy: 'krusch-harness', createdAt: new Date().toISOString() }
    });

    const fsm = new KruschFSM(task.id, HARNESS_PHASES.INIT);
    console.log(`[krusch] Initialized task ${task.id} in PostgreSQL (Phase: ${fsm.currentPhase})`);

    const tools = new KruschTools(task.id, projectPath, { policy: this.policy });
    const toolDefs = tools.getDefinitions();

    // 2. Assemble Grounded Context from AST & Memory
    const context = await KruschContextClient.assembleContext(projectPath, goal);
    const contextPromptBlock = KruschContextClient.formatContextPrompt(context);

    // Transition INIT -> PLAN
    await fsm.transitionTo(HARNESS_PHASES.PLAN);

    // 3. Select Initial Model via Cascade Router
    let route = modelOverride
      ? { modelId: modelOverride, stage: 'MANUAL', role: 'custom', rationale: 'User manual model override' }
      : this.router.route(goal, { priorFailureCount: 0 });

    console.log(`[krusch] Routing: selected [${route.modelId}] via [${route.stage}] (${route.rationale})`);
    await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });

    // 4. Invariant Prompt Template with Token-Budgeted Context
    const systemPrompt = `You are an engineering coding agent running within the Krusch harness.
Your goal: "${goal}"

${contextPromptBlock}

Operating Workflow Rules:
1. Always explore and read relevant files before modifying.
2. Use 'stage_diff' to propose modifications into PostgreSQL.
3. Use 'run_command' to run existing tests or verify syntax.
4. Changes can only be applied to disk once ground-truth verification passes.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute the following engineering goal: ${goal}` }
    ];

    const turnHistory = [];
    let consecutiveTestFailures = 0;
    let latestTestPassed = false;

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      console.log(`[krusch] ─── Turn ${turnNum}/${maxTurns} [Phase: ${fsm.currentPhase} | Model: ${route.modelId}] ───`);

      // Trajectory health check
      const trajectoryStatus = this.guard.evaluateTrajectory(turnHistory);
      if (!trajectoryStatus.healthy) {
        console.warn(`[krusch] Trajectory Guard triggered: ${trajectoryStatus.reason}`);
        if (trajectoryStatus.action === 'ESCALATE_TO_FRONTIER') {
          route = this.router.route(goal, { priorFailureCount: 2, requireFrontier: true });
          console.log(`[krusch] Escalating turn to frontier model: ${route.modelId}`);
          await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });
        } else {
          await fsm.transitionTo(HARNESS_PHASES.ABORTED, { reason: trajectoryStatus.reason });
          return { status: HARNESS_PHASES.ABORTED, reason: trajectoryStatus.reason, taskId: task.id };
        }
      }

      // Execute Model Turn
      const adapter = this.registry.getAdapter(route.modelId);
      const turnResult = await adapter.execute({
        modelId: route.modelId,
        messages,
        tools: toolDefs
      });

      // Record Turn in PostgreSQL
      const recordedTurn = await KruschStateManager.recordTurn(task.id, {
        turnNumber: turnNum,
        modelId: route.modelId,
        inputMessages: messages,
        outputText: turnResult.text,
        tokenUsage: turnResult.usage,
        latencyMs: turnResult.latencyMs,
        routingStage: route.stage
      });

      turnHistory.push({
        turnNumber: turnNum,
        outputText: turnResult.text,
        toolCalls: turnResult.toolCalls
      });

      // Add assistant response to context
      messages.push({
        role: 'assistant',
        content: turnResult.text || '',
        tool_calls: turnResult.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) }
        }))
      });

      // If no tool calls, model considers task finished
      if (turnResult.toolCalls.length === 0) {
        console.log(`[krusch] Model finished generation without further tool invocations.`);
        break;
      }

      // Execute Tool Invocations
      for (const toolCall of turnResult.toolCalls) {
        // FSM Transition on Action
        if (toolCall.name === 'stage_diff' && fsm.currentPhase === HARNESS_PHASES.PLAN) {
          await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
        } else if (toolCall.name === 'run_command') {
          if (fsm.currentPhase === HARNESS_PHASES.PLAN || fsm.currentPhase === HARNESS_PHASES.IMPLEMENT) {
            await fsm.transitionTo(HARNESS_PHASES.VERIFY);
          }
        }

        console.log(`[krusch] Executing tool [${toolCall.name}]:`, JSON.stringify(toolCall.args));
        const result = await tools.executeTool(toolCall.name, toolCall.args);

        // Record event in PostgreSQL
        await KruschStateManager.recordEvent(task.id, recordedTurn.id, `tool_${toolCall.name}`, {
          args: toolCall.args,
          result
        });

        // Test failure analysis via ModularRSI
        if (toolCall.name === 'run_command') {
          latestTestPassed = result.passed;
          if (!result.passed) {
            consecutiveTestFailures++;
            const failureAttribution = KruschModularRSI.attributeFailure(result);
            console.warn(`[krusch:rsi] Verification Failure attributed to [${failureAttribution.module}]: ${failureAttribution.diagnosis}`);

            // Escalate model if multiple consecutive verification failures occur
            if (consecutiveTestFailures >= 2 && route.stage !== 'FRONTIER_ESCALATION') {
              route = this.router.route(goal, { priorFailureCount: consecutiveTestFailures, requireFrontier: true });
              console.log(`[krusch] Escalating to [${route.modelId}] due to verification failures.`);
              await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });
            }

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                output: result.stdout || result.stderr,
                rsi_diagnostic: failureAttribution
              })
            });
            continue;
          } else {
            consecutiveTestFailures = 0;
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    }

    // Check for pending staged diffs and finalize FSM phase
    const pendingDiffs = await KruschStateManager.getPendingDiffs(task.id);

    if (pendingDiffs.length > 0) {
      if (latestTestPassed && fsm.currentPhase === HARNESS_PHASES.VERIFY) {
        // Safe to enter APPROVAL_GATE
        await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);
        console.log(`[krusch] Verification PASSED. Task entered APPROVAL_GATE with ${pendingDiffs.length} staged diff(s).`);

        // If auto-approve policy active, apply diffs to disk and transition to COMMITTED
        if (this.policy.autoApprove) {
          for (const diff of pendingDiffs) {
            await tools.executeTool('apply_staged_diff', { diffId: diff.id });
          }
          await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
          console.log(`[krusch] Auto-applied ${pendingDiffs.length} staged diff(s) to physical disk.`);
        }
      } else if (!latestTestPassed && fsm.currentPhase === HARNESS_PHASES.VERIFY) {
        console.warn(`[krusch] Verification FAILED. Diffs remain staged in PostgreSQL; disk mutation strictly blocked.`);
      }
    } else {
      if (fsm.currentPhase !== HARNESS_PHASES.ABORTED) {
        if (fsm.canTransitionTo(HARNESS_PHASES.COMMITTED)) {
          await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
        }
      }
    }

    return {
      status: fsm.currentPhase,
      taskId: task.id,
      turnsExecuted: turnHistory.length,
      stagedDiffsCount: pendingDiffs.length,
      finalModel: route.modelId
    };
  }
}
