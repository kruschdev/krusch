import test from 'node:test';
import assert from 'node:assert';
import { KruschCascadeRouter } from '../../src/router/cascade.js';

test('KruschCascadeRouter: L1 fast-path intercepts SQL queries with <15µs CPU routing', () => {
  const router = new KruschCascadeRouter();
  const route = router.route('SELECT * FROM users WHERE active = true;');
  assert.strictEqual(route.stage, 'L1_FAST_PATH');
  assert.strictEqual(route.role, 'code');
  assert.ok(route.modelId.includes('coder') || route.modelId.includes('qwen'));
});

test('KruschCascadeRouter: Escalates to frontier reasoning when failure count > 0', () => {
  const router = new KruschCascadeRouter();
  const route = router.route('Fix unexpected edge case', { priorFailureCount: 2 });
  assert.strictEqual(route.stage, 'FRONTIER_ESCALATION');
  assert.strictEqual(route.role, 'frontier');
  assert.ok(route.modelId.includes('deepseek') || route.modelId.includes('claude'));
});

test('KruschCascadeRouter: Closed-world queries route to general fast model', () => {
  const router = new KruschCascadeRouter();
  const route = router.route('Convert 45 miles per hour to meters per second');
  assert.strictEqual(route.stage, 'L1_FAST_PATH');
  assert.strictEqual(route.role, 'closed_world');
  assert.ok(route.modelId.includes('flash'));
});
