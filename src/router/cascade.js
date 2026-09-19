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

export class KruschCascadeRouter {
  constructor(options = {}) {
    this.specialists = { ...DEFAULT_SPECIALISTS, ...(options.customModels || {}) };
  }

  /**
   * Route a prompt to the optimal specialist or escalate to frontier.
   */
  route(prompt, context = {}) {
    // 0. Failure Escalation Check: If prior attempts failed or frontier is explicitly required, escalate immediately.
    if ((context.priorFailureCount && context.priorFailureCount > 0) || context.requireFrontier) {
      const frontierModel = context.requireFrontier ? this.specialists.frontier : this.specialists.reasoning_deep;
      return {
        modelId: frontierModel,
        stage: 'FRONTIER_ESCALATION',
        confidence: 'high',
        role: 'frontier',
        rationale: `Escalated to frontier reasoning model (prior failures: ${context.priorFailureCount || 0}).`
      };
    }

    // 1. Stage-1 (L1) Microsecond Syntactic Gate (<15µs on CPU)
    const preRoute = classifyPreRoute(prompt);

    if (preRoute.isFastPath) {
      const specialistKey = preRoute.role || 'code';
      const selectedModel = this.specialists[specialistKey] || this.specialists.code;
      return {
        modelId: selectedModel,
        stage: 'L1_FAST_PATH',
        confidence: preRoute.confidence,
        role: specialistKey,
        ruleId: preRoute.ruleId,
        rationale: `L1 fast-path matched rule [${preRoute.ruleId}] in <15µs ($0.00 routing cost).`
      };
    }

    // 2. Closed-World Knowledge Boundary Check
    const isClosedWorld = detectKnowledgeBoundary ? detectKnowledgeBoundary(prompt) : false;
    if (isClosedWorld) {
      return {
        modelId: this.specialists.general_fast,
        stage: 'L1_FAST_PATH',
        confidence: 'high',
        role: 'closed_world',
        rationale: 'Self-contained closed-world query routed to high-throughput edge model.'
      };
    }

    // 3. Complexity Evaluation
    const complexity = evaluateComplexityScore ? evaluateComplexityScore(prompt) : 0.5;
    if (complexity > 0.4 || context.priorFailureCount > 0) {
      // Escalation to deep reasoning / frontier
      const frontierModel = context.requireFrontier ? this.specialists.frontier : this.specialists.reasoning_deep;
      return {
        modelId: frontierModel,
        stage: 'FRONTIER_ESCALATION',
        confidence: 'high',
        role: 'frontier',
        rationale: `Escalated to frontier reasoning model (complexity score: ${complexity.toFixed(3)}, prior failures: ${context.priorFailureCount || 0}).`
      };
    }

    // 4. Default to General Fast with L2 escalation recommendation
    return {
      modelId: this.specialists.general_fast,
      stage: 'L2_CENTROID',
      confidence: 'medium',
      role: 'general_fast',
      rationale: 'Conversational intent without explicit syntax signatures; routed to balanced specialist.'
    };
  }
}
