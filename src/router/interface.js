/**
 * Krusch Router Interface & Built-In Heuristic Gate
 *
 * Core Thesis: Models are ephemeral compute; the router is an interchangeable interface.
 * Zero external dependencies: fast-path regex gate + deterministic specialist selection.
 */

export const DEFAULT_SPECIALISTS = {
  code: process.env.MODEL_CODE || 'qwen/qwen-2.5-coder-32b-instruct',
  math: process.env.MODEL_MATH || 'deepseek/deepseek-v4-flash',
  stem: process.env.MODEL_STEM || 'deepseek/deepseek-v4-flash',
  general_fast: process.env.MODEL_FAST || 'google/gemini-2.5-flash',
  reasoning_deep: process.env.MODEL_REASONING || 'deepseek/deepseek-r1',
  frontier: process.env.MODEL_FRONTIER || 'anthropic/claude-3-7-sonnet',
  local_ollama: process.env.MODEL_LOCAL || 'hermes3:8b'
};

export const COST_ESTIMATES = {
  L1_FAST_PATH: '$0.00',
  PINNED: 'variable',
  closed_world: '$0.0001',
  general_fast: '$0.0001',
  code: '$0.0005',
  math: '$0.0005',
  stem: '$0.0005',
  reasoning_deep: '$0.002',
  frontier: '$0.015'
};

export const DEFAULT_ESCALATION_POLICY = {
  maxFailuresBeforeFrontier: 2,
  escalateOnClasses: ['ObservationManagement', 'AgentLoop'],
  preservePinnedModel: true
};

// Zero-dependency built-in regex heuristics
const REGEX_SQL = /\b(?:SELECT\s+[\s\S]+?\s+FROM|INSERT\s+INTO|UPDATE\s+[\s\S]+?\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i;
const REGEX_CODE_FENCE = /```(?!(?:md|markdown|text|plain|txt|prose)\b)[a-zA-Z0-9_#+-]*\b[\s\S]*?```/i;
const REGEX_STACK_TRACE = /(?:Traceback \(most recent call last\)|TypeError:|SyntaxError:|ReferenceError:|NullPointerException|IndexOutOfBoundsException|ModuleNotFoundError:|panic:|Segmentation fault|SIGSEGV|Uncaught Error:)/i;
const REGEX_CLOSED_WORLD = /\b(?:Given (?:the|a) (?:list|array|table|passage|function|input|matrix)|Convert \d+|Compute the determinant|reverse it and explain)\b/i;

/**
 * Built-in zero-dependency classifier
 */
export function classifyPrompt(prompt) {
  if (typeof prompt !== 'string') return { isFastPath: false };

  if (REGEX_SQL.test(prompt)) {
    return { isFastPath: true, role: 'code', ruleId: 'structure:sql', confidence: 'high' };
  }

  if (REGEX_STACK_TRACE.test(prompt)) {
    return { isFastPath: true, role: 'code', ruleId: 'structure:stack_trace', confidence: 'high' };
  }

  if (REGEX_CODE_FENCE.test(prompt)) {
    return { isFastPath: true, role: 'code', ruleId: 'structure:code_fence', confidence: 'high' };
  }

  if (REGEX_CLOSED_WORLD.test(prompt)) {
    return { isFastPath: true, role: 'closed_world', ruleId: 'closed_world_boundary', confidence: 'high' };
  }

  return { isFastPath: false };
}

/**
 * Default in-repo router implementing KruschRouter interface
 */
export class DefaultKruschRouter {
  constructor(options = {}) {
    this.specialists = { ...DEFAULT_SPECIALISTS, ...(options.customModels || {}) };
    this.escalationPolicy = { ...DEFAULT_ESCALATION_POLICY, ...(options.escalationPolicy || {}) };
  }

  route(prompt, context = {}) {
    const startTime = performance.now();

    // 0. Model Pinning Check
    if (context.pinnedModel && this.escalationPolicy.preservePinnedModel && !context.forceEscalate) {
      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: context.pinnedModel,
        stage: 'PINNED',
        confidence: 'high',
        role: 'pinned',
        ruleId: null,
        latencyMs: elapsedMs,
        costEstimate: COST_ESTIMATES.PINNED,
        rationale: `Preserved task pinned model [${context.pinnedModel}] across execution resume.`
      };
    }

    // 1. Failure Escalation Check
    const failureCount = context.priorFailureCount || 0;
    const failureClass = context.failureClass || null;
    const shouldEscalateClass = failureClass && this.escalationPolicy.escalateOnClasses.includes(failureClass);

    if (
      failureCount >= this.escalationPolicy.maxFailuresBeforeFrontier ||
      context.requireFrontier ||
      (failureCount > 0 && shouldEscalateClass)
    ) {
      const frontierModel = (context.requireFrontier || failureCount >= this.escalationPolicy.maxFailuresBeforeFrontier)
        ? this.specialists.frontier
        : this.specialists.reasoning_deep;

      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: frontierModel,
        stage: 'FRONTIER_ESCALATION',
        confidence: 'high',
        role: 'frontier',
        ruleId: null,
        latencyMs: elapsedMs,
        costEstimate: frontierModel === this.specialists.frontier ? COST_ESTIMATES.frontier : COST_ESTIMATES.reasoning_deep,
        rationale: `Escalated to frontier reasoning model (failures: ${failureCount}, class: ${failureClass || 'none'}).`
      };
    }

    // 2. Stage-1 (L1) Microsecond Syntactic Heuristic Gate
    const classification = classifyPrompt(prompt);

    if (classification.isFastPath) {
      if (classification.role === 'closed_world') {
        const elapsedMs = Number((performance.now() - startTime).toFixed(3));
        return {
          modelId: this.specialists.general_fast,
          stage: 'L1_FAST_PATH',
          confidence: 'high',
          role: 'closed_world',
          ruleId: classification.ruleId,
          latencyMs: elapsedMs,
          costEstimate: COST_ESTIMATES.closed_world,
          rationale: 'Self-contained closed-world query routed to high-throughput edge model.'
        };
      }

      const specialistKey = classification.role || 'code';
      const selectedModel = this.specialists[specialistKey] || this.specialists.code;
      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: selectedModel,
        stage: 'L1_FAST_PATH',
        confidence: classification.confidence,
        role: specialistKey,
        ruleId: classification.ruleId,
        latencyMs: elapsedMs,
        costEstimate: COST_ESTIMATES.L1_FAST_PATH,
        rationale: `L1 fast-path matched rule [${classification.ruleId}] with $0.00 heuristic routing cost.`
      };
    }

    // 3. Complexity Evaluation
    const wordCount = (prompt || '').split(/\s+/).length;
    if (wordCount > 60 || prompt.includes('refactor') || prompt.includes('optimize') || prompt.includes('architecture')) {
      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: this.specialists.reasoning_deep,
        stage: 'FRONTIER_ESCALATION',
        confidence: 'high',
        role: 'reasoning_deep',
        ruleId: null,
        latencyMs: elapsedMs,
        costEstimate: COST_ESTIMATES.reasoning_deep,
        rationale: `Escalated to reasoning specialist based on prompt complexity.`
      };
    }

    // 4. Default Balanced Fast Tier
    const elapsedMs = Number((performance.now() - startTime).toFixed(3));
    return {
      modelId: this.specialists.general_fast,
      stage: 'L2_CENTROID',
      confidence: 'medium',
      role: 'general_fast',
      ruleId: null,
      latencyMs: elapsedMs,
      costEstimate: COST_ESTIMATES.general_fast,
      rationale: 'Conversational intent without explicit syntax signatures; routed to balanced fast model.'
    };
  }
}
