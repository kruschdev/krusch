import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { KruschFSM, HARNESS_PHASES } from '../../src/workflow/fsm.js';
import { KruschTools } from '../../src/tools/index.js';

test('Enforcement: FSM strictly blocks transition to APPROVAL_GATE when tests fail', async () => {
  const taskId = `enforce_fsm_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test verification transition gate',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.INIT
  });

  const fsm = new KruschFSM(taskId, HARNESS_PHASES.INIT);
  await fsm.transitionTo(HARNESS_PHASES.PLAN);
  await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
  await fsm.transitionTo(HARNESS_PHASES.VERIFY);

  // Record a failing verification test run in PostgreSQL
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 1,
    stdout: '',
    stderr: 'AssertionError: expected 2 to equal 4',
    passed: false
  });

  // Attempt to transition to APPROVAL_GATE while verification is failing
  await assert.rejects(
    async () => {
      await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);
    },
    (err) => {
      assert.ok(err.message.includes('Invariant Violation'));
      assert.ok(err.message.includes('verification is failing'));
      return true;
    }
  );

  // State must remain in VERIFY
  assert.strictEqual(fsm.currentPhase, HARNESS_PHASES.VERIFY);
});

test('Enforcement: apply_staged_diff strictly refuses to write disk on failed verification', async () => {
  const taskId = `enforce_write_${Date.now()}`;
  const targetRelFile = `test/scratch_failing_${Date.now()}.txt`;
  const targetAbsFile = path.resolve(process.cwd(), targetRelFile);

  // Ensure file does not exist on disk
  if (fs.existsSync(targetAbsFile)) fs.unlinkSync(targetAbsFile);

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test refuse-to-write on test failure',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.VERIFY
  });

  const tools = new KruschTools(taskId, process.cwd(), { autoApprove: true });

  // 1. Stage diff into PostgreSQL
  const staged = await tools.executeTool('stage_diff', {
    path: targetRelFile,
    content: 'CRITICAL BROKEN CODE PATCH',
    explanation: 'Testing verification block'
  });
  assert.strictEqual(staged.status, 'STAGED');
  assert.ok(staged.diffId);

  // 2. Record failing verification test
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 1,
    stdout: '',
    stderr: 'TypeError: cannot read property of undefined',
    passed: false
  });

  // 3. Attempt to apply staged diff to physical disk
  const applyResult = await tools.executeTool('apply_staged_diff', { diffId: staged.diffId });

  // 4. Assert disk mutation is strictly rejected
  assert.ok(applyResult.error, 'apply_staged_diff should have returned an error');
  assert.ok(
    applyResult.error === 'MUTATION_BLOCKED_INVALID_PHASE' || applyResult.error === 'VERIFICATION_FAILED_MUTATION_BLOCKED'
  );

  // 5. Invariant check: Physical disk MUST NOT have been touched!
  assert.strictEqual(fs.existsSync(targetAbsFile), false, 'Disk file MUST NOT exist after failed verification');

  // 6. Now simulate a passing verification run and proper FSM transition
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: '14 passing',
    stderr: '',
    passed: true
  });

  const fsm = new KruschFSM(taskId, HARNESS_PHASES.VERIFY);
  await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);

  // 7. Now applying staged diff must succeed
  const validApply = await tools.executeTool('apply_staged_diff', { diffId: staged.diffId });
  assert.strictEqual(validApply.status, 'APPLIED');
  assert.strictEqual(fs.existsSync(targetAbsFile), true, 'File should exist on disk after passing verification');
  assert.strictEqual(fs.readFileSync(targetAbsFile, 'utf-8'), 'CRITICAL BROKEN CODE PATCH');

  // Clean up test file
  fs.unlinkSync(targetAbsFile);
});

test.after(async () => {
  await pool.end();
});
