/**
 * Type declarations for Krusch Coding Harness (v0.1.0).
 * Postgres-backed coding harness that stages diffs, runs tests, and only then writes the working tree.
 */

export interface TaskRecord {
  id: string;
  goal: string;
  project_path: string;
  phase: HarnessPhase;
  current_model: string | null;
  metadata: Record<string, any>;
  verification_command?: string | null;
  created_at: string;
  updated_at: string;
  turns?: TurnRecord[];
  stagedDiffs?: StagedDiffRecord[];
  approvals?: ApprovalRecord[];
  verifications?: VerificationRunRecord[];
}

export type HarnessPhase =
  | 'INIT'
  | 'PLAN'
  | 'IMPLEMENT'
  | 'VERIFY'
  | 'APPROVAL_GATE'
  | 'COMMITTED'
  | 'ABORTED';

export const HARNESS_PHASES: Record<HarnessPhase, HarnessPhase>;

export interface TurnRecord {
  id: number;
  task_id: string;
  turn_number: number;
  model_id: string;
  input_messages: any[];
  output_text: string | null;
  thought_trace: string | null;
  token_usage: Record<string, any>;
  latency_ms: number | null;
  routing_stage: string | null;
  created_at: string;
}

export interface StagedDiffRecord {
  id: number;
  task_id: string;
  project_path?: string;
  file_path: string;
  original_content: string | null;
  staged_content: string;
  diff_patch: string | null;
  status: 'PENDING' | 'APPLYING' | 'APPLIED' | 'COMMITTED' | 'REJECTED';
  sha256_hash: string;
  original_sha256: string | null;
  lease_expires_at?: string | null;
  created_at: string;
  applied_at: string | null;
}

export interface KruschPhaseEdge {
  from_phase: HarnessPhase;
  to_phase: HarnessPhase;
}

export interface ApprovalRecord {
  id: number;
  task_id: string;
  action_type: string;
  target_resource: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_BYPASSED';
  requested_by_model: string | null;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface VerificationRunRecord {
  id: number;
  task_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  failure_module: string | null;
  extracted_errors: any[];
  created_at: string;
  duration_ms?: number;
}

export function canonicalizePaths(projectPath: string, filePath: string): { projectPath: string; filePath: string };

export class KruschFSM {
  taskId: string;
  currentPhase: HarnessPhase;
  constructor(taskId: string, initialPhase?: HarnessPhase);
  static loadAllowedTransitions(client?: any): Promise<Record<HarnessPhase, HarnessPhase[]>>;
  static getAllowedTransitions(): Record<HarnessPhase, HarnessPhase[]>;
  syncPhase(): Promise<HarnessPhase>;
  canTransitionTo(targetPhase: HarnessPhase, fromPhase?: HarnessPhase | null): boolean;
  transitionTo(targetPhase: HarnessPhase, metadata?: Record<string, any>): Promise<{ from: HarnessPhase; to: HarnessPhase }>;
}

export class KruschStateManager {
  static createTask(params: {
    id?: string;
    goal: string;
    projectPath: string;
    phase?: HarnessPhase;
    currentModel?: string | null;
    metadata?: Record<string, any>;
    verificationCommand?: string | null;
  }): Promise<TaskRecord>;

  static updateTask(
    taskId: string,
    params: { phase?: HarnessPhase; currentModel?: string; metadata?: Record<string, any> }
  ): Promise<TaskRecord>;

  static getTask(taskId: string): Promise<TaskRecord | null>;

  static recordTurn(
    taskId: string,
    turn: {
      turnNumber: number;
      modelId: string;
      inputMessages: any[];
      outputText?: string | null;
      thoughtTrace?: string | null;
      tokenUsage?: Record<string, any>;
      latencyMs?: number | null;
      routingStage?: string;
    }
  ): Promise<TurnRecord>;

  static recordEvent(taskId: string, turnId: number | null, eventType: string, payload: any): Promise<any>;

  static stageDiff(
    taskId: string,
    diff: {
      filePath: string;
      originalContent?: string | null;
      stagedContent: string;
      diffPatch?: string;
      projectPath?: string;
    }
  ): Promise<StagedDiffRecord>;

  static pruneExpiredLeases(): Promise<any[]>;

  static releaseLease(taskId: string, filePath: string, projectPath?: string | null): Promise<StagedDiffRecord | null>;

  static listActiveLeases(projectPath?: string | null): Promise<any[]>;

  static recoverInFlightApplies(projectPath?: string | null): Promise<any[]>;

  static applyDiffBatch(taskId: string, diffIds?: number[] | null, projectPath?: string | null): Promise<{
    status: string;
    appliedCount: number;
    diffs?: Array<{ id: number; filePath: string }>;
  }>;

  static explainTaskStatus(taskId: string): Promise<any>;

  static formatExplainOutput(explanation: any): string;

  static getPendingDiffs(taskId: string): Promise<StagedDiffRecord[]>;

  static getStagedDiffs(taskId: string): Promise<StagedDiffRecord[]>;

  static getActiveDiffs(taskId: string): Promise<StagedDiffRecord[]>;

  static updateDiffStatus(diffId: number, status: 'PENDING' | 'APPLYING' | 'APPLIED' | 'COMMITTED' | 'REJECTED'): Promise<StagedDiffRecord>;

  static requestApproval(
    taskId: string,
    approval: {
      actionType: string;
      targetResource: string;
      requestedByModel?: string;
      status?: string;
      decisionReason?: string | null;
    }
  ): Promise<ApprovalRecord>;

  static decideApproval(approvalId: number, status: string, decisionReason?: string): Promise<ApprovalRecord>;

  static recordVerificationRun(
    taskId: string,
    run: {
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      passed: boolean;
      failureModule?: string | null;
      extractedErrors?: any[];
    },
    client?: any
  ): Promise<VerificationRunRecord>;

  static recordVerificationAndTransition(
    taskId: string,
    verifData: {
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      passed: boolean;
      failureModule?: string | null;
      extractedErrors?: any[];
    },
    targetPhase?: HarnessPhase | null,
    metadata?: Record<string, any>
  ): Promise<{ verificationRun: VerificationRunRecord; transition: any }>;

  static getLatestVerificationRun(taskId: string, client?: any): Promise<VerificationRunRecord | null>;

  static hasUnappliedStagedDiffs(taskId: string, client?: any): Promise<boolean>;

  static hasAnyStagedDiffs(taskId: string, client?: any): Promise<boolean>;

  static atomicTransitionPhase(
    taskId: string,
    targetPhase: HarnessPhase,
    allowedSourcePhases?: HarnessPhase[],
    guardValidator?: (ctx: { task: TaskRecord; client: any; targetPhase: HarnessPhase }) => Promise<void>,
    metadata?: Record<string, any>
  ): Promise<{ from: HarnessPhase; to: HarnessPhase; task: TaskRecord }>;
}

export interface RouteResult {
  modelId: string;
  stage: string;
  confidence: string;
  role: string;
  ruleId?: string | null;
  latencyMs: number;
  costEstimate: string;
  rationale: string;
}

export class KruschCascadeRouter {
  specialists: Record<string, string>;
  escalationPolicy: Record<string, any>;
  constructor(options?: { customModels?: Record<string, string>; escalationPolicy?: Record<string, any> });
  route(prompt: string, context?: Record<string, any>): RouteResult;
}

export class KruschTools {
  taskId: string;
  projectPath: string;
  policy: any;
  constructor(taskId: string, projectPath: string, options?: any);
  getDefinitions(): any[];
  executeTool(name: string, args?: Record<string, any>): Promise<any>;
}

export class KruschStateMachine {
  constructor(options?: any);
  runTask(params: {
    goal: string;
    projectPath?: string;
    maxTurns?: number;
    modelOverride?: string | null;
  }): Promise<{
    status: HarnessPhase;
    taskId: string;
    turnsExecuted: number;
    stagedDiffsCount: number;
    finalModel: string;
  }>;
}

export class KruschTrajectoryGuard {
  constructor(options?: { maxTurns?: number; loopWindowSize?: number });
  evaluateTrajectory(turnHistory: any[]): { healthy: boolean; reason?: string; action?: string };
}

export const RSI_MODULES: {
  AGENT_LOOP: string;
  TOOL_USE: string;
  OBSERVATION_MGMT: string;
  CONTEXT_MGMT: string;
  TASK_COMPLETION: string;
};

export const RSI_ACTION_TYPES: {
  REFETCH_SYMBOLS: string;
  SWITCH_TOOL_NORMALIZER: string;
  FORMAT_ASSERTION_DIFF: string;
  ESCALATE_TIER_OR_ABORT: string;
};

export class KruschModularRSI {
  static attributeFailure(testRun: any): {
    module: string;
    actionType: string;
    missingSymbol?: string | null;
    diagnosis: string;
    remediation: string;
  };
}

export class KruschTestRunner {
  static detectTestCommand(projectPath?: string): string | null;
  static parseErrors(stdout?: string, stderr?: string): any[];
  static runCommand(command: string, cwd?: string, options?: any): Promise<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
    durationMs: number;
    extractedErrors?: any[];
  }>;
}

export class KruschApprovalPolicy {
  autoApprove: boolean;
  constructor(options?: any);
  evaluate(toolName: string, args?: any): { status: 'AUTO_APPROVED' | 'STAGED' | 'REQUIRE_APPROVAL'; reason: string };
}

export function startMcpServer(): Promise<void>;
