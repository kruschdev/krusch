import { KruschStateManager } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschCascadeRouter } from '../router/cascade.js';
import { ModelRegistry } from '../models/registry.js';
import { KruschTools } from '../tools/index.js';
import { KruschTrajectoryGuard } from './trajectory-guard.js';
import { KruschFailureClassifier, RSI_ACTION_TYPES } from './modular-rsi.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';
import { KruschFSM, HARNESS_PHASES } from './fsm.js';

function getPhaseObjective(phase, verificationCommand) {
  switch (phase) {
    case HARNESS_PHASES.PLAN:
      return `[ACTIVE HARNESS PHASE: PLAN]
Phase Objective: Read-only repository discovery and mapping.
- Inspect relevant files with 'read_file' and locate symbols with 'search_symbols'.
- Propose a concrete implementation plan.
- Invariant Rule: Tool 'stage_diff' is strictly withheld in PLAN. Do not attempt disk mutations.`;
    case HARNESS_PHASES.IMPLEMENT:
      return `[ACTIVE HARNESS PHASE: IMPLEMENT]
Phase Objective: Code modification and staging.
- Stage atomic file updates directly into PostgreSQL ACID substrate using 'stage_diff'.
- Invariant Rule: All staged diffs are stored in PostgreSQL; disk writes remain strictly blocked until verification passes.`;
    case HARNESS_PHASES.VERIFY:
      return `[ACTIVE HARNESS PHASE: VERIFY]
Phase Objective: Ground-truth verification.
- Execute the verification command using 'run_command'${verificationCommand ? ` (Target: "${verificationCommand}")` : ''}.
- Invariant Rule: No new diffs can be staged in VERIFY. Validated pass (exit code 0) is required to unlock APPROVAL_GATE.`;
    case HARNESS_PHASES.APPROVAL_GATE:
      return `[ACTIVE HARNESS PHASE: APPROVAL_GATE]
Phase Objective: Human-in-the-loop inspection and disk commit.
- Verification tests have passed. Apply staged diffs to the working tree using 'apply_staged_diff'.
- Invariant Rule: No new modifications may be staged.`;
    default:
      return `[ACTIVE HARNESS PHASE: ${phase}]`;
  }
}

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
1. Phase-Scoped Tool Discipline: Each turn operates within an explicit FSM phase with designated tools.
2. In PLAN phase: Inspect and read relevant files before modifying (use token-bounded 'read_file' and 'search_symbols').
3. In IMPLEMENT phase: Use 'stage_diff' to propose modifications into PostgreSQL ACID storage.
4. In VERIFY phase: Use 'run_command' to run existing tests or verify syntax.
5. In APPROVAL_GATE phase: Apply staged diffs to disk via 'apply_staged_diff' once verified.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Execute the following engineering goal: ${goal}` }
    ];

    const turnHistory = [];
    let consecutiveTestFailures = 0;
    let latestTestPassed = false;
    let latestFailureClass = null;
    let remediationCount = 0;
    const MAX_REMEDIATIONS = 3;

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

      // 1. Determine active phase and phase-scoped tool definitions
      const activeToolDefs = tools.getDefinitions(fsm.currentPhase);
      const phaseDirective = getPhaseObjective(fsm.currentPhase, task.verification_command);

      // Inject active turn objective into turn messages
      const turnMessages = [
        ...messages,
        { role: 'user', content: phaseDirective }
      ];

      // Execute Model Turn with phase-scoped tools
      const adapter = this.registry.getAdapter(route.modelId);
      const turnResult = await adapter.execute({
        modelId: route.modelId,
        messages: turnMessages,
        tools: activeToolDefs
      });

      // Record Turn in PostgreSQL
      const recordedTurn = await KruschStateManager.recordTurn(task.id, {
        turnNumber: turnNum,
        modelId: route.modelId,
        inputMessages: turnMessages,
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

      // If no tool calls, model considers current turn generation finished
      if (turnResult.toolCalls.length === 0) {
        console.log(`[krusch] Model finished generation without further tool invocations.`);
        const currentDiffs = await KruschStateManager.getStagedDiffs(task.id);
        if (currentDiffs.length === 0 && fsm.canTransitionTo(HARNESS_PHASES.COMMITTED)) {
          await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
          console.log(`[krusch:fsm] Read-only task completed without staged diffs. Transitioned to COMMITTED.`);
          break;
        }
      }

      // Execute Tool Invocations
      for (const toolCall of turnResult.toolCalls) {
        console.log(`[krusch] Executing tool [${toolCall.name}]:`, JSON.stringify(toolCall.args));
        const result = await tools.executeTool(toolCall.name, toolCall.args, { phase: fsm.currentPhase });

        // Record event in PostgreSQL
        await KruschStateManager.recordEvent(task.id, recordedTurn.id, `tool_${toolCall.name}`, {
          args: toolCall.args,
          result
        });

        // Test failure analysis via KruschFailureClassifier
        if (toolCall.name === 'run_command') {
          latestTestPassed = result.passed;
          if (!result.passed) {
            consecutiveTestFailures++;
            const failureAttribution = KruschFailureClassifier.attributeFailure(result);
            latestFailureClass = failureAttribution.module;
            console.warn(`[krusch:classifier] Verification Failure attributed to [${failureAttribution.module}]: ${failureAttribution.diagnosis}`);

            let remediationPayload = null;
            if (remediationCount < MAX_REMEDIATIONS) {
              remediationCount++;
              remediationPayload = {
                module: failureAttribution.module,
                actionType: failureAttribution.actionType,
                diagnosis: failureAttribution.diagnosis,
                remediation: failureAttribution.remediation
              };

              if (failureAttribution.actionType === RSI_ACTION_TYPES.REFETCH_SYMBOLS && failureAttribution.missingSymbol) {
                const matchedSymbols = await KruschContextClient.searchCodeSymbols(failureAttribution.missingSymbol, 5);
                remediationPayload.matchedSymbols = matchedSymbols;
              }
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
                exit_code: result.exitCode,
                passed: false,
                diagnostic: failureAttribution.diagnosis,
                remediation: remediationPayload
              })
            });
            continue;
          } else {
            consecutiveTestFailures = 0;
            latestFailureClass = null;
            console.log(`[krusch:verify] Verification passed with exit code 0.`);
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      // ─── Post-Turn State-Evidence Evaluation ───
      const pendingDiffs = await KruschStateManager.getPendingDiffs(task.id);
      const latestRun = await KruschStateManager.getLatestVerificationRun(task.id);

      if (fsm.currentPhase === HARNESS_PHASES.PLAN) {
        if (turnResult.toolCalls.length === 0 && pendingDiffs.length === 0) {
          if (fsm.canTransitionTo(HARNESS_PHASES.COMMITTED)) {
            await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
            console.log(`[krusch:fsm] Read-only task completed in PLAN phase. Transitioned to COMMITTED.`);
            break;
          }
        } else {
          await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
          console.log(`[krusch:fsm] Planning turn concluded. Transitioned PLAN -> IMPLEMENT.`);
        }
      } else if (fsm.currentPhase === HARNESS_PHASES.IMPLEMENT) {
        if (pendingDiffs.length > 0) {
          await fsm.transitionTo(HARNESS_PHASES.VERIFY);
          console.log(`[krusch:fsm] Staged diffs detected (${pendingDiffs.length}). Transitioned IMPLEMENT -> VERIFY.`);
        }
      } else if (fsm.currentPhase === HARNESS_PHASES.VERIFY) {
        if (latestRun && latestRun.passed && latestRun.exit_code === 0) {
          await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);
          console.log(`[krusch:fsm] Ground-truth verification PASSED. Transitioned VERIFY -> APPROVAL_GATE.`);

          if (this.policy.autoApprove) {
            const batchResult = await KruschStateManager.applyDiffBatch(task.id, null, projectPath);
            await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
            console.log(`[krusch:fsm] Auto-applied ${batchResult.appliedCount} staged diff(s) to physical disk. Task COMMITTED.`);
          }
          break;
        } else if (latestRun && !latestRun.passed) {
          await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
          console.warn(`[krusch:fsm] Verification failed. Transitioned VERIFY -> IMPLEMENT to allow restaging.`);
        }
      }
    }

    // Check for pending staged diffs and return authoritative status
    const allDiffs = await KruschStateManager.getStagedDiffs(task.id);
    return {
      status: fsm.currentPhase,
      taskId: task.id,
      turnsExecuted: turnHistory.length,
      stagedDiffsCount: allDiffs.length,
      finalModel: route.modelId
    };
  }
}

