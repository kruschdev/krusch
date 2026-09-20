import { classifyPreRoute, detectKnowledgeBoundary, evaluateComplexityScore } from 'krusch-pre-router';

export const DEFAULT_SPECIALISTS = {
  code: process.env.MODEL_CODE || 'qwen/qwen-2.5-coder-32b-instruct',
  math: process.env.MODEL_MATH || 'deepseek/deepseek-v4-flash',
  stem: process.env.MODEL_STEM || 'deepseek/deepseek-v4-flash',
  general_fast: process.env.MODEL_FAST || 'google/gemini-2.5-flash',
  reasoning_deep: process.env.MODEL_REASONING || 'deepseek/deepseek-r1',
  frontier: process.env.MODEL_FRONTIER || 'anthropic/claude-3-7-sonnet',
  local_ollama: process.env.MODEL_LOCAL || 'hermes3:8b'
};

export const DEFAULT_ESCALATION_POLICY = {
  maxFailuresBeforeFrontier: 2,
  escalateOnClasses: ['ObservationManagement', 'AgentLoop'],
  preservePinnedModel: true
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

export class KruschCascadeRouter {
  constructor(options = {}) {
    this.specialists = { ...DEFAULT_SPECIALISTS, ...(options.customModels || {}) };
    this.escalationPolicy = { ...DEFAULT_ESCALATION_POLICY, ...(options.escalationPolicy || {}) };
  }

  /**
   * Route a prompt to the optimal specialist or escalate to frontier based on intent, complexity, and policy.
   */
  route(prompt, context = {}) {
    const startTime = performance.now();

    // 0. Model Pinning Check: if task is pinned and policy preserves pinned model
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

    // 1. Failure Escalation Check: Evaluate against structured escalation policy
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

    // 2. Stage-1 (L1) Microsecond Syntactic Gate on CPU
    const preRoute = classifyPreRoute(prompt);

    if (preRoute.isFastPath) {
      const specialistKey = preRoute.role || 'code';
      const selectedModel = this.specialists[specialistKey] || this.specialists.code;
      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: selectedModel,
        stage: 'L1_FAST_PATH',
        confidence: preRoute.confidence,
        role: specialistKey,
        ruleId: preRoute.ruleId,
        latencyMs: elapsedMs,
        costEstimate: COST_ESTIMATES.L1_FAST_PATH,
        rationale: `L1 fast-path matched rule [${preRoute.ruleId}] with $0.00 heuristic routing cost.`
      };
    }

    // 3. Closed-World Knowledge Boundary Check
    const isClosedWorld = detectKnowledgeBoundary ? detectKnowledgeBoundary(prompt) : false;
    if (isClosedWorld) {
      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: this.specialists.general_fast,
        stage: 'L1_FAST_PATH',
        confidence: 'high',
        role: 'closed_world',
        ruleId: 'closed_world_boundary',
        latencyMs: elapsedMs,
        costEstimate: COST_ESTIMATES.closed_world,
        rationale: 'Self-contained closed-world query routed to high-throughput edge model.'
      };
    }

    // 4. Complexity Evaluation Gate
    const complexity = evaluateComplexityScore ? evaluateComplexityScore(prompt) : 0.5;
    if (complexity > 0.4) {
      const elapsedMs = Number((performance.now() - startTime).toFixed(3));
      return {
        modelId: this.specialists.reasoning_deep,
        stage: 'FRONTIER_ESCALATION',
        confidence: 'high',
        role: 'reasoning_deep',
        ruleId: null,
        latencyMs: elapsedMs,
        costEstimate: COST_ESTIMATES.reasoning_deep,
        rationale: `Escalated to reasoning specialist (complexity score: ${complexity.toFixed(3)}).`
      };
    }

    // 5. Default Balanced Fast Tier
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
