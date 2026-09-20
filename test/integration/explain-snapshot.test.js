import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { query, pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('Explain Diagnostic Snapshot: Exact copy matches PostgreSQL trigger invariants across all phases', async () => {
  const taskId = `explain_snap_${Date.now()}`;
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-explain-'));

  // 1. INIT Phase
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Snapshot explain diagnostics against PostgreSQL triggers',
    projectPath: testDir,
    phase: HARNESS_PHASES.INIT,
    currentModel: 'google/gemini-2.5-flash',
    verificationCommand: 'npm run test:unit'
  });

  let exp = await KruschStateManager.explainTaskStatus(taskId);
  assert.strictEqual(exp.phase, 'INIT');
  assert.strictEqual(exp.isTerminal, false);
  assert.strictEqual(exp.verificationCommand, 'npm run test:unit');
  let formatted = KruschStateManager.formatExplainOutput(exp);
  assert.ok(formatted.includes('Current Phase: INIT'));
  assert.ok(formatted.includes('Test Command:  npm run test:unit'));
  assert.ok(formatted.includes('✓ ALLOWED INIT ➔ PLAN'));

  // 2. PLAN Phase - Read-only (zero diffs) allows direct commit
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.PLAN, taskId]);
  exp = await KruschStateManager.explainTaskStatus(taskId);
  let planToCommit = exp.possibleTransitions.find(t => t.to === 'COMMITTED');
  assert.ok(planToCommit);
  assert.strictEqual(planToCommit.reason, 'ALLOWED: Read-only task with zero staged diffs.');

  // 3. PLAN Phase - Staged diff exists blocks shortcut to COMMITTED
  const diff = await KruschStateManager.stageDiff(taskId, {
    filePath: 'sample.js',
    originalContent: '// initial',
    stagedContent: '// staged in plan',
    diffPatch: 'fix',
    projectPath: testDir
  });

  exp = await KruschStateManager.explainTaskStatus(taskId);
  planToCommit = exp.possibleTransitions.find(t => t.to === 'COMMITTED');
  assert.ok(planToCommit.reason.startsWith('BLOCKED'));
  assert.ok(planToCommit.reason.includes('Cannot shortcut from PLAN to COMMITTED while staged diffs exist'));

  // Assert PostgreSQL trigger error matches explain copy
  let shortcutBlocked = false;
  try {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  } catch (err) {
    shortcutBlocked = true;
    assert.ok(err.message.includes('Cannot shortcut from PLAN to COMMITTED while staged diffs exist'));
  }
  assert.strictEqual(shortcutBlocked, true);

  // 4. VERIFY Phase (via legal edge IMPLEMENT -> VERIFY)
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.IMPLEMENT, taskId]);
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.VERIFY, taskId]);
  exp = await KruschStateManager.explainTaskStatus(taskId);
  let verifyToGate = exp.possibleTransitions.find(t => t.to === 'APPROVAL_GATE');
  assert.strictEqual(verifyToGate.reason, 'BLOCKED: Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test');

  let noVerifBlocked = false;
  try {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);
  } catch (err) {
    noVerifBlocked = true;
    assert.ok(err.message.includes('Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test'));
  }
  assert.strictEqual(noVerifBlocked, true);

  // 5. VERIFY Phase - Failing test run blocks transition to APPROVAL_GATE
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm run test:unit',
    exitCode: 1,
    stdout: 'AssertionError: expected true to be false',
    stderr: '',
    passed: false
  });

  exp = await KruschStateManager.explainTaskStatus(taskId);
  verifyToGate = exp.possibleTransitions.find(t => t.to === 'APPROVAL_GATE');
  assert.strictEqual(verifyToGate.reason, 'BLOCKED: Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: 1)');

  let failVerifBlocked = false;
  try {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);
  } catch (err) {
    failVerifBlocked = true;
    assert.ok(err.message.includes('Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: 1)'));
  }
  assert.strictEqual(failVerifBlocked, true);

  // 6. VERIFY Phase - Passing test run allows transition to APPROVAL_GATE
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm run test:unit',
    exitCode: 0,
    stdout: 'tests 1 passed',
    stderr: '',
    passed: true
  });

  exp = await KruschStateManager.explainTaskStatus(taskId);
  verifyToGate = exp.possibleTransitions.find(t => t.to === 'APPROVAL_GATE');
  assert.ok(verifyToGate.reason.startsWith('ALLOWED: Ground-truth tests passed'));

  // Database transition to APPROVAL_GATE succeeds
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);

  // 7. APPROVAL_GATE Phase - Pending unapplied diffs block COMMITTED
  exp = await KruschStateManager.explainTaskStatus(taskId);
  let gateToCommit = exp.possibleTransitions.find(t => t.to === 'COMMITTED');
  assert.strictEqual(gateToCommit.reason, 'BLOCKED: Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING');

  let pendingCommitBlocked = false;
  try {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  } catch (err) {
    pendingCommitBlocked = true;
    assert.ok(err.message.includes('Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING'));
  }
  assert.strictEqual(pendingCommitBlocked, true);

  // 7b. APPROVAL_GATE Phase - Staged diff marked REJECTED blocks COMMITTED
  await query(`UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1`, [diff.id]);
  exp = await KruschStateManager.explainTaskStatus(taskId);
  gateToCommit = exp.possibleTransitions.find(t => t.to === 'COMMITTED');
  assert.strictEqual(gateToCommit.reason, 'BLOCKED: Cannot transition from APPROVAL_GATE to COMMITTED while staged diffs remain REJECTED');

  let rejectedCommitBlocked = false;
  try {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  } catch (err) {
    rejectedCommitBlocked = true;
    assert.ok(err.message.includes('Cannot transition from APPROVAL_GATE to COMMITTED while staged diffs remain REJECTED'));
  }
  assert.strictEqual(rejectedCommitBlocked, true);

  // 8. APPROVAL_GATE Phase - Diff applied allows COMMITTED
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLIED', applied_at = NOW() WHERE id = $1`, [diff.id]);
  exp = await KruschStateManager.explainTaskStatus(taskId);
  gateToCommit = exp.possibleTransitions.find(t => t.to === 'COMMITTED');
  assert.strictEqual(gateToCommit.reason, 'ALLOWED: All staged diffs are applied to physical disk.');

  // Database transition to COMMITTED succeeds
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);

  // 9. COMMITTED Phase - Terminal state with 0 next transitions
  exp = await KruschStateManager.explainTaskStatus(taskId);
  assert.strictEqual(exp.phase, 'COMMITTED');
  assert.strictEqual(exp.isTerminal, true);
  assert.strictEqual(exp.possibleTransitions.length, 0);

  formatted = KruschStateManager.formatExplainOutput(exp);
  assert.ok(formatted.includes('Current Phase: COMMITTED (Terminal)'));
  assert.ok(formatted.includes('Next Transition Feasibility:'));

  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
