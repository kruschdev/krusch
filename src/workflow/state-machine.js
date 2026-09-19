import { KruschStateManager } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschCascadeRouter } from '../router/cascade.js';
import { ModelRegistry } from '../models/registry.js';
import { KruschTools } from '../tools/index.js';
import { KruschTrajectoryGuard } from './trajectory-guard.js';
import { KruschModularRSI } from './modular-rsi.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';

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
      phase: 'PLAN',
      metadata: { initiatedBy: 'krusch-harness', createdAt: new Date().toISOString() }
    });

    console.log(`[krusch] Initialized task ${task.id} in PostgreSQL`);
    const tools = new KruschTools(task.id, projectPath, { policy: this.policy });
    const toolDefs = tools.getDefinitions();

    // 2. Assemble Grounded Context from AST & Memory
    const context = await KruschContextClient.assembleContext(projectPath, goal);

    // 3. Select Initial Model via Cascade Router
    let route = modelOverride
      ? { modelId: modelOverride, stage: 'MANUAL', role: 'custom', rationale: 'User manual model override' }
      : this.router.route(goal, { priorFailureCount: 0 });

    console.log(`[krusch] Routing: selected [${route.modelId}] via [${route.stage}] (${route.rationale})`);
    await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });

    // 4. Invariant Prompt Template
    const systemPrompt = `You are a sovereign coding agent running within the Krusch harness.
Your goal: "${goal}"
Repository files: ${JSON.stringify(context.files.slice(0, 30))}
Relevant AST Symbols: ${JSON.stringify(context.symbols)}

Operating Rules:
1. Always explore and read relevant files before modifying.
2. Use 'stage_diff' to propose modifications into PostgreSQL.
3. Use 'run_command' to run existing tests or verify syntax.
4. When finished, summarize what was verified.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute the following engineering goal: ${goal}` }
    ];

    const turnHistory = [];
    let currentPhase = 'PLAN';
    let consecutiveTestFailures = 0;

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      console.log(`[krusch] ─── Turn ${turnNum}/${maxTurns} [Model: ${route.modelId}] ───`);

      // Trajectory health check
      const trajectoryStatus = this.guard.evaluateTrajectory(turnHistory);
      if (!trajectoryStatus.healthy) {
        console.warn(`[krusch] Trajectory Guard triggered: ${trajectoryStatus.reason}`);
        if (trajectoryStatus.action === 'ESCALATE_TO_FRONTIER') {
          route = this.router.route(goal, { priorFailureCount: 2, requireFrontier: true });
          console.log(`[krusch] Escalating turn to frontier model: ${route.modelId}`);
          await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });
        } else {
          await KruschStateManager.updateTask(task.id, { phase: 'ABORTED' });
          return { status: 'ABORTED', reason: trajectoryStatus.reason, taskId: task.id };
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

      // If no tool calls, model considers turn or task finished
      if (turnResult.toolCalls.length === 0) {
        console.log(`[krusch] Model provided final response without further tool invocations.`);
        currentPhase = 'COMPLETE';
        break;
      }

      // Execute Tool Invocations
      for (const toolCall of turnResult.toolCalls) {
        console.log(`[krusch] Executing tool [${toolCall.name}]:`, JSON.stringify(toolCall.args));
        const result = await tools.executeTool(toolCall.name, toolCall.args);

        // Record event in PostgreSQL
        await KruschStateManager.recordEvent(task.id, recordedTurn.id, `tool_${toolCall.name}`, {
          args: toolCall.args,
          result
        });

        // Test failure analysis via ModularRSI
        if (toolCall.name === 'run_command' && result.passed === false) {
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
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }
      }
    }

    // Check for pending staged diffs
    const pendingDiffs = await KruschStateManager.getPendingDiffs(task.id);
    if (pendingDiffs.length > 0) {
      currentPhase = 'APPROVAL';
      console.log(`[krusch] Task has ${pendingDiffs.length} staged file modification(s) pending approval in PostgreSQL.`);
    } else {
      currentPhase = 'COMPLETE';
    }

    await KruschStateManager.updateTask(task.id, { phase: currentPhase });
    return {
      status: currentPhase,
      taskId: task.id,
      turnsExecuted: turnHistory.length,
      stagedDiffsCount: pendingDiffs.length,
      finalModel: route.modelId
    };
  }
}
