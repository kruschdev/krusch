import { KruschStateManager } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschCascadeRouter } from '../router/cascade.js';
import { ModelRegistry } from '../models/registry.js';
import { KruschTools } from '../tools/index.js';
import { KruschTrajectoryGuard } from './trajectory-guard.js';
import { KruschModularRSI, RSI_ACTION_TYPES } from './modular-rsi.js';
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
  async runTask({ goal, projectPath = process.cwd(), maxTurns = 10, modelOverride = null, verificationCommand = null }) {
    // 0. Startup Crash Recovery & Lease Maintenance: inspect and resolve in-flight applies, and prune expired leases
    const recovered = await KruschStateManager.recoverInFlightApplies(projectPath);
    if (recovered.length > 0) {
      console.log(`[krusch] Recovered ${recovered.length} in-flight diff apply operation(s) from prior session.`);
    }
    const pruned = await KruschStateManager.pruneExpiredLeases();
    if (pruned.length > 0) {
      console.log(`[krusch] Pruned ${pruned.length} expired file concurrency lease(s).`);
    }

    const pinnedModel = modelOverride || this.options.pinnedModel || null;

    // 1. Initialize Task in PostgreSQL Cognitive Substrate
    const task = await KruschStateManager.createTask({
      goal,
      projectPath,
      phase: HARNESS_PHASES.INIT,
      verificationCommand,
      metadata: {
        initiatedBy: 'krusch-harness',
        pinnedModel,
        createdAt: new Date().toISOString()
      }
    });

    const fsm = new KruschFSM(task.id, HARNESS_PHASES.INIT);
    console.log(`[krusch] Initialized task ${task.id} in PostgreSQL (Phase: ${fsm.currentPhase})`);

    const tools = new KruschTools(task.id, projectPath, {
      policy: this.policy,
      verificationCommand: task.verification_command
    });
    const toolDefs = tools.getDefinitions();

    // 2. Assemble Grounded Context from AST & Memory
    const context = await KruschContextClient.assembleContext(projectPath, goal);
    const contextPromptBlock = KruschContextClient.formatContextPrompt(context);

    // Transition INIT -> PLAN
    await fsm.transitionTo(HARNESS_PHASES.PLAN);

    // 3. Select Initial Model via Cascade Router
    let route = this.router.route(goal, {
      pinnedModel,
      priorFailureCount: 0
    });

    console.log(`[krusch] Routing: selected [${route.modelId}] via [${route.stage}] (Est: ${route.costEstimate}, Latency: ${route.latencyMs}ms)`);
    await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });

    // Record routing event in PostgreSQL
    await KruschStateManager.recordEvent(task.id, null, 'routing_decision', {
      stage: route.stage,
      modelId: route.modelId,
      latencyMs: route.latencyMs,
      costEstimate: route.costEstimate,
      ruleId: route.ruleId,
      rationale: route.rationale
    });

    // 4. Invariant Prompt Template with Token-Budgeted Context
    const systemPrompt = `You are an engineering coding agent running within the Krusch harness.
Your goal: "${goal}"

${contextPromptBlock}

Operating Workflow Rules:
1. Always explore and read relevant files before modifying (use token-bounded 'read_file').
2. Use 'stage_diff' to propose modifications into PostgreSQL ACID storage.
3. Use 'run_command' to run existing tests or verify syntax.
4. Changes can only be applied to physical disk once ground-truth verification passes.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute the following engineering goal: ${goal}` }
    ];

    const turnHistory = [];
    let consecutiveTestFailures = 0;
    let latestTestPassed = false;
    let latestFailureClass = null;

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      console.log(`[krusch] ─── Turn ${turnNum}/${maxTurns} [Phase: ${fsm.currentPhase} | Model: ${route.modelId}] ───`);

      // Trajectory health check
      const trajectoryStatus = this.guard.evaluateTrajectory(turnHistory);
      if (!trajectoryStatus.healthy) {
        console.warn(`[krusch] Trajectory Guard triggered: ${trajectoryStatus.reason}`);
        if (trajectoryStatus.action === 'ESCALATE_TO_FRONTIER') {
          route = this.router.route(goal, {
            pinnedModel,
            priorFailureCount: 2,
            requireFrontier: true,
            forceEscalate: true
          });
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
        if (toolCall.name === 'stage_diff' && (fsm.currentPhase === HARNESS_PHASES.PLAN || fsm.currentPhase === HARNESS_PHASES.VERIFY)) {
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
            latestFailureClass = failureAttribution.module;
            console.warn(`[krusch:rsi] Verification Failure attributed to [${failureAttribution.module}]: ${failureAttribution.diagnosis}`);

            // Actionable ModularRSI Remediations:
            if (failureAttribution.actionType === RSI_ACTION_TYPES.REFETCH_SYMBOLS && failureAttribution.missingSymbol) {
              const matchedSymbols = await KruschContextClient.searchCodeSymbols(failureAttribution.missingSymbol, 5);
              const symbolPrompt = matchedSymbols.length > 0
                ? KruschContextClient.formatSymbols(matchedSymbols)
                : `Symbol '${failureAttribution.missingSymbol}' not found in AST index. Ensure correct imports and package dependencies.`;
              messages.push({
                role: 'system',
                content: `[KruschModularRSI Context Remediation]: The test failed due to an unresolved import/symbol: "${failureAttribution.missingSymbol}". Available symbols:\n${symbolPrompt}`
              });
            } else if (failureAttribution.actionType === RSI_ACTION_TYPES.FORMAT_ASSERTION_DIFF) {
              messages.push({
                role: 'system',
                content: `[KruschModularRSI Assertion Remediation]: Ground-truth verification assertions failed. Invariant rule: Staged code modifications must satisfy assertions without regressing existing behavior.\nDiagnosis: ${failureAttribution.diagnosis}\nRemediation: ${failureAttribution.remediation}`
              });
            } else if (failureAttribution.actionType === RSI_ACTION_TYPES.SWITCH_TOOL_NORMALIZER) {
              messages.push({
                role: 'system',
                content: `[KruschModularRSI ToolUse Remediation]: Syntactic or parameter formatting error detected. Ensure exact parameter schema compliance and valid JavaScript/TypeScript syntax before re-staging.`
              });
            }

            // Escalate model if multiple consecutive verification failures occur
            if (consecutiveTestFailures >= 2 && route.stage !== 'FRONTIER_ESCALATION') {
              route = this.router.route(goal, {
                pinnedModel,
                priorFailureCount: consecutiveTestFailures,
                failureClass: latestFailureClass,
                requireFrontier: true,
                forceEscalate: true
              });
              console.log(`[krusch] Escalating to [${route.modelId}] due to repeated verification failures.`);
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
            latestFailureClass = null;
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
    const allDiffs = await KruschStateManager.getStagedDiffs(task.id);
    const hasRejected = allDiffs.some(d => d.status === 'REJECTED');

    if (hasRejected) {
      console.warn(`[krusch] Task contains REJECTED staged diff(s). Preserving working tree; modifications must be re-staged and re-verified.`);
    } else if (pendingDiffs.length > 0) {
      if (latestTestPassed && fsm.currentPhase === HARNESS_PHASES.VERIFY) {
        // Safe to enter APPROVAL_GATE
        await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);
        console.log(`[krusch] Verification PASSED. Task entered APPROVAL_GATE with ${pendingDiffs.length} staged diff(s).`);

        // If auto-approve policy active, apply all diffs to disk as an atomic batch unit
        if (this.policy.autoApprove) {
          const batchResult = await KruschStateManager.applyDiffBatch(task.id, null, projectPath);
          await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
          console.log(`[krusch] Auto-applied ${batchResult.appliedCount} staged diff(s) to physical disk.`);
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
