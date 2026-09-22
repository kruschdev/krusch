import test from 'node:test';
import assert from 'node:assert';
import { enableEphemeralMode, disableEphemeralMode, isEphemeralMode, closePool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { KruschStateMachine } from '../../src/workflow/state-machine.js';
import { MockModelAdapter } from '../../src/models/providers/mock.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('Integration: In-process ephemeral mode enables zero-setup local evaluation', async () => {
  // 1. Enable ephemeral mode
  await enableEphemeralMode();
  assert.strictEqual(isEphemeralMode(), true);

  // 2. Create task in ephemeral PGlite
  const taskId = `ephemeral_${Date.now()}`;
  const task = await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test zero-setup evaluation on ephemeral PGlite substrate',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN,
    metadata: { ephemeral: true }
  });

  assert.strictEqual(task.id, taskId);
  assert.strictEqual(task.phase, HARNESS_PHASES.PLAN);

  // 3. Stage diff into ephemeral PostgreSQL catalog
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/ephemeral_test.js',
    originalContent: '// empty',
    stagedContent: '// updated in ephemeral mode',
    diffPatch: '@@ -1 +1 @@\n-// empty\n+// updated in ephemeral mode\n'
  });
  assert.strictEqual(staged.status, 'PENDING');
  assert.ok(staged.sha256_hash);

  // 4. Transition through FSM with row-locked validation in PGlite
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.IMPLEMENT });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.VERIFY });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'Ephemeral tests passed',
    stderr: '',
    passed: true,
    sandboxType: 'ephemeral-mock'
  });

  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.APPROVAL_GATE });
  const updatedDiff = await KruschStateManager.updateDiffStatus(staged.id, 'APPLIED');
  assert.strictEqual(updatedDiff.status, 'APPLIED');

  const finalTask = await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  assert.strictEqual(finalTask.phase, HARNESS_PHASES.COMMITTED);

  // 5. Test KruschStateMachine running end-to-end task with Mock adapter on PGlite
  const mock = new MockModelAdapter();
  mock.setNextResponse({
    text: 'Ephemeral task executed directly.',
    toolCalls: [],
    usage: { total_tokens: 42 },
    latencyMs: 5
  });

  const harness = new KruschStateMachine({
    useMock: true,
    mockAdapter: mock
  });

  const runResult = await harness.runTask({
    goal: 'Autonomous mock task in PGlite',
    projectPath: process.cwd(),
    maxTurns: 2
  });

  assert.strictEqual(runResult.status, HARNESS_PHASES.COMMITTED);
  assert.strictEqual(runResult.turnsExecuted, 1);

  // 6. Tear down ephemeral pool cleanly and restore mode
  await closePool();
  disableEphemeralMode();
});
