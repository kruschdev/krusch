import crypto from 'crypto';

/**
 * Pricing rates per 1,000,000 tokens for cost estimation
 */
const MODEL_PRICING = {
  'google/gemini-2.5-flash': { prompt: 0.075, completion: 0.30 },
  'anthropic/claude-3-5-sonnet': { prompt: 3.00, completion: 15.00 },
  'anthropic/claude-3-7-sonnet': { prompt: 3.00, completion: 15.00 },
  'deepseek/deepseek-r1': { prompt: 0.55, completion: 2.19 },
  'meta-llama/llama-3.3-70b-instruct': { prompt: 0.12, completion: 0.30 },
  'qwen/qwen-2.5-coder-32b-instruct': { prompt: 0.07, completion: 0.16 },
  'mock/deterministic': { prompt: 0.0, completion: 0.0 }
};

export class KruschTelemetry {
  /**
   * Calculate cost estimate in USD based on model pricing table.
   */
  static calculateTokenCost(modelId, promptTokens = 0, completionTokens = 0) {
    const rate = MODEL_PRICING[modelId] || MODEL_PRICING['google/gemini-2.5-flash'];
    const promptCost = (promptTokens / 1_000_000) * rate.prompt;
    const completionCost = (completionTokens / 1_000_000) * rate.completion;
    return Number((promptCost + completionCost).toFixed(6));
  }

  /**
   * Build OpenTelemetry-compatible JSON trace with cost ledger from task state.
   */
  static buildTrace(task) {
    if (!task) return null;

    const traceId = crypto.createHash('sha256').update(task.id).digest('hex').slice(0, 32);
    const spans = [];

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalLatencyMs = 0;
    let totalCostUsd = 0;
    let l1InterceptCount = 0;

    // 1. Task Root Span
    const rootSpanId = crypto.randomBytes(8).toString('hex');
    spans.push({
      traceId,
      spanId: rootSpanId,
      parentSpanId: null,
      name: `task:${task.phase}`,
      kind: 'SERVER',
      startTime: task.created_at,
      attributes: {
        'krusch.task_id': task.id,
        'krusch.goal': task.goal,
        'krusch.project_path': task.project_path,
        'krusch.phase': task.phase,
        'krusch.current_model': task.current_model || 'none',
        'krusch.verification_command': task.verification_command || 'none'
      }
    });

    // 2. Turns Spans
    if (Array.isArray(task.turns)) {
      for (const turn of task.turns) {
        const turnSpanId = crypto.randomBytes(8).toString('hex');
        const promptTokens = turn.token_usage?.prompt_tokens || turn.token_usage?.input_tokens || 0;
        const completionTokens = turn.token_usage?.completion_tokens || turn.token_usage?.output_tokens || 0;
        const turnCost = KruschTelemetry.calculateTokenCost(turn.model_id, promptTokens, completionTokens);

        totalPromptTokens += promptTokens;
        totalCompletionTokens += completionTokens;
        totalLatencyMs += turn.latency_ms || 0;
        totalCostUsd += turnCost;

        if (turn.routing_stage === 'L1_FAST_PATH') {
          l1InterceptCount++;
        }

        spans.push({
          traceId,
          spanId: turnSpanId,
          parentSpanId: rootSpanId,
          name: `model_turn:${turn.turn_number}`,
          kind: 'CLIENT',
          startTime: turn.created_at,
          durationMs: turn.latency_ms || 0,
          attributes: {
            'llm.model': turn.model_id,
            'llm.routing_stage': turn.routing_stage || 'unknown',
            'llm.tokens.prompt': promptTokens,
            'llm.tokens.completion': completionTokens,
            'llm.cost_usd': turnCost
          }
        });
      }
    }

    // 3. Verification Run Spans
    if (Array.isArray(task.verifications)) {
      for (const v of task.verifications) {
        const verifSpanId = crypto.randomBytes(8).toString('hex');
        spans.push({
          traceId,
          spanId: verifSpanId,
          parentSpanId: rootSpanId,
          name: 'verification_sandbox',
          kind: 'INTERNAL',
          startTime: v.created_at,
          durationMs: v.duration_ms || 0,
          attributes: {
            'verify.command': v.command,
            'verify.exit_code': v.exit_code,
            'verify.passed': v.passed,
            'verify.sandbox_type': v.sandbox_type || 'process',
            'verify.replay_token': v.replay_token || null,
            'verify.failure_module': v.failure_module || null
          }
        });
      }
    }

    // 4. Staged Diffs Spans
    if (Array.isArray(task.stagedDiffs)) {
      for (const d of task.stagedDiffs) {
        const diffSpanId = crypto.randomBytes(8).toString('hex');
        spans.push({
          traceId,
          spanId: diffSpanId,
          parentSpanId: rootSpanId,
          name: `staged_diff:${d.file_path}`,
          kind: 'INTERNAL',
          startTime: d.created_at,
          attributes: {
            'diff.file_path': d.file_path,
            'diff.status': d.status,
            'diff.sha256': d.sha256_hash,
            'diff.original_sha256': d.original_sha256,
            'diff.applied_at': d.applied_at
          }
        });
      }
    }

    // 5. Apply Journal Spans
    if (Array.isArray(task.applyJournals)) {
      for (const j of task.applyJournals) {
        const journalSpanId = crypto.randomBytes(8).toString('hex');
        spans.push({
          traceId,
          spanId: journalSpanId,
          parentSpanId: rootSpanId,
          name: `apply_journal:${j.id}`,
          kind: 'INTERNAL',
          startTime: j.created_at,
          attributes: {
            'journal.id': j.id,
            'journal.state': j.state,
            'journal.completed_at': j.completed_at,
            'journal.error': j.error_message || null
          }
        });
      }
    }

    const costLedger = {
      totalTokens: totalPromptTokens + totalCompletionTokens,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
      totalLatencyMs,
      l1FastPathInterceptions: l1InterceptCount,
      estimatedL1SavingsUsd: Number((l1InterceptCount * 0.001).toFixed(4))
    };

    return {
      traceId,
      taskId: task.id,
      goal: task.goal,
      phase: task.phase,
      costLedger,
      spansCount: spans.length,
      spans,
      exportedAt: new Date().toISOString()
    };
  }
}
