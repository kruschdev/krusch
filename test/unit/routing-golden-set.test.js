import test from 'node:test';
import assert from 'node:assert';
import { KruschCascadeRouter, DEFAULT_SPECIALISTS, COST_ESTIMATES } from '../../src/router/cascade.js';

test('Routing Golden Set: Deterministic dispatch for code, SQL, math, and frontier models', () => {
  const router = new KruschCascadeRouter();

  // 1. Obvious SQL query -> L1 fast-path code specialist with $0.00 cost
  const sqlDecision = router.route('SELECT id, name, email FROM users WHERE active = true ORDER BY created_at DESC');
  assert.strictEqual(sqlDecision.stage, 'L1_FAST_PATH');
  assert.strictEqual(sqlDecision.role, 'code');
  assert.strictEqual(sqlDecision.modelId, DEFAULT_SPECIALISTS.code);
  assert.strictEqual(sqlDecision.costEstimate, COST_ESTIMATES.L1_FAST_PATH);
  assert.ok(sqlDecision.latencyMs >= 0);

  // 2. Closed-world self-contained query -> general_fast edge model
  const closedWorldDecision = router.route('Given the list [1, 2, 3, 4], reverse it and explain the time complexity.');
  assert.strictEqual(closedWorldDecision.stage, 'L1_FAST_PATH');
  assert.strictEqual(closedWorldDecision.role, 'closed_world');
  assert.strictEqual(closedWorldDecision.modelId, DEFAULT_SPECIALISTS.general_fast);

  // 3. Repeated failure count -> Frontier Escalation (Claude 3.7 Sonnet)
  const failureEscalation = router.route('Fix the race condition in the database connection pool', {
    priorFailureCount: 2
  });
  assert.strictEqual(failureEscalation.stage, 'FRONTIER_ESCALATION');
  assert.strictEqual(failureEscalation.modelId, DEFAULT_SPECIALISTS.frontier);
  assert.strictEqual(failureEscalation.costEstimate, COST_ESTIMATES.frontier);

  // 4. Attribution class escalation: ObservationManagement with failure -> reasoning model
  const obsEscalation = router.route('Optimize the query performance', {
    priorFailureCount: 1,
    failureClass: 'ObservationManagement'
  });
  assert.strictEqual(obsEscalation.stage, 'FRONTIER_ESCALATION');
  assert.strictEqual(obsEscalation.modelId, DEFAULT_SPECIALISTS.reasoning_deep);

  // 5. Model Pinning: Preserves pinned model across resume without unsolicited churn
  const pinnedDecision = router.route('Refactor auth module', {
    pinnedModel: 'ollama/deepseek-coder:6.7b',
    priorFailureCount: 1
  });
  assert.strictEqual(pinnedDecision.stage, 'PINNED');
  assert.strictEqual(pinnedDecision.modelId, 'ollama/deepseek-coder:6.7b');
  assert.ok(pinnedDecision.rationale.includes('Preserved task pinned model'));

  // 6. Math / Closed-world query -> L1 fast-path closed-world specialist
  const mathDecision = router.route('Compute the determinant of a 3x3 matrix: [[1, 2, 3], [0, 1, 4], [5, 6, 0]]');
  assert.strictEqual(mathDecision.stage, 'L1_FAST_PATH');
  assert.strictEqual(mathDecision.costEstimate, COST_ESTIMATES.closed_world);
  assert.ok(mathDecision.latencyMs < 50);

  // 7. Force escalation overrides pinned model when explicitly requested
  const forcedDecision = router.route('Critical crash loop in memory manager', {
    pinnedModel: 'ollama/deepseek-coder:6.7b',
    priorFailureCount: 3,
    forceEscalate: true
  });
  assert.strictEqual(forcedDecision.stage, 'FRONTIER_ESCALATION');
  assert.strictEqual(forcedDecision.modelId, DEFAULT_SPECIALISTS.frontier);
  assert.strictEqual(forcedDecision.costEstimate, COST_ESTIMATES.frontier);
});
