import test from 'node:test';
import assert from 'node:assert';
import { pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { KruschStateMachine } from '../../src/workflow/state-machine.js';
import { MockModelAdapter } from '../../src/models/providers/mock.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('Integration: Krusch PostgreSQL state persistence and task lifecycle', async () => {
  const taskId = `test_task_${Date.now()}`;
  const task = await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test PostgreSQL Cognitive Substrate',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN,
    metadata: { test: true }
  });

  assert.strictEqual(task.id, taskId);
  assert.strictEqual(task.phase, HARNESS_PHASES.PLAN);

  // Record a turn
  const turn = await KruschStateManager.recordTurn(taskId, {
    turnNumber: 1,
    modelId: 'mock/qwen-test',
    inputMessages: [{ role: 'user', content: 'hello' }],
    outputText: 'Let me stage a diff.',
    tokenUsage: { total_tokens: 50 },
    latencyMs: 15,
    routingStage: 'L1_FAST_PATH'
  });
  assert.strictEqual(turn.turn_number, 1);

  // Stage a diff in PostgreSQL
  const testFilePath = `test/sample_${Date.now()}.txt`;
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: testFilePath,
    originalContent: 'hello',
    stagedContent: 'hello world',
    diffPatch: 'Added world'
  });
  assert.strictEqual(staged.status, 'PENDING');
  assert.ok(staged.sha256_hash);

  // Verify task retrieval
  const retrieved = await KruschStateManager.getTask(taskId);
  assert.strictEqual(retrieved.id, taskId);
  assert.strictEqual(retrieved.turns.length, 1);
  assert.strictEqual(retrieved.stagedDiffs.length, 1);
  assert.strictEqual(retrieved.stagedDiffs[0].file_path, testFilePath);

  // Progress task through lifecycle: PLAN -> IMPLEMENT -> VERIFY -> APPROVAL_GATE
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.IMPLEMENT });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.VERIFY });
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'Tests passed',
    stderr: '',
    passed: true
  });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.APPROVAL_GATE });

  // Update diff status to APPLIED (allowed in APPROVAL_GATE with passing verification)
  const updatedDiff = await KruschStateManager.updateDiffStatus(staged.id, 'APPLIED');
  assert.strictEqual(updatedDiff.status, 'APPLIED');

  // Transition to COMMITTED
  const finalTask = await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  assert.strictEqual(finalTask.phase, HARNESS_PHASES.COMMITTED);
});

test('Integration: KruschStateMachine executes task with MockModelAdapter', async () => {
  const mock = new MockModelAdapter();
  mock.setNextResponse({
    text: 'I completed the task directly without tool calls.',
    toolCalls: [],
    usage: { total_tokens: 80 },
    latencyMs: 10
  });

  const harness = new KruschStateMachine({
    useMock: true,
    mockAdapter: mock
  });

  const result = await harness.runTask({
    goal: 'Execute sample task through mock adapter',
    projectPath: process.cwd(),
    maxTurns: 3
  });

  assert.strictEqual(result.status, HARNESS_PHASES.COMMITTED);
  assert.strictEqual(result.turnsExecuted, 1);
  assert.strictEqual(result.stagedDiffsCount, 0);

  const taskRecord = await KruschStateManager.getTask(result.taskId);
  assert.strictEqual(taskRecord.phase, HARNESS_PHASES.COMMITTED);
});

test.after(async () => {
  await pool.end();
});
