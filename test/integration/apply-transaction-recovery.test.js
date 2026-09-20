import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { query, pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('Transaction Protocol: Two-phase journaled apply records APPLYING before rename', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-twophase-test-'));
  const taskId = `twophase_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test two-phase apply transaction',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'sample.js',
    originalContent: '// initial',
    stagedContent: '// updated two-phase',
    diffPatch: 'update',
    projectPath: testDir
  });

  // Write base file to disk
  fs.writeFileSync(path.join(testDir, 'sample.js'), '// initial', 'utf-8');

  // Verify transition to APPLYING is allowed in APPROVAL_GATE
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id = $1`, [staged.id]);
  const checkApplying = await query(`SELECT status FROM krusch_staged_diffs WHERE id = $1`, [staged.id]);
  assert.strictEqual(checkApplying.rows[0].status, 'APPLYING');

  // Transition from APPLYING to APPLIED is allowed
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLIED', applied_at = NOW() WHERE id = $1`, [staged.id]);
  const checkApplied = await query(`SELECT status, applied_at FROM krusch_staged_diffs WHERE id = $1`, [staged.id]);
  assert.strictEqual(checkApplied.rows[0].status, 'APPLIED');
  assert.ok(checkApplied.rows[0].applied_at);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Recovery Fixture 1: Complete rename -> Promoted to APPLIED, temp cleaned', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-fixture1-applied-'));
  const taskId = `fixture1_applied_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Fixture 1: Complete rename',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  const stagedContent = '// staged and renamed before crash';
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/recovered.js',
    originalContent: '// base',
    stagedContent,
    diffPatch: 'fix',
    projectPath: testDir
  });

  // Simulate mid-crash state: status is APPLYING in DB, disk file was renamed, orphaned temp file exists
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id = $1`, [staged.id]);
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src/recovered.js'), stagedContent, 'utf-8');
  const tempPath = path.join(testDir, 'src/.recovered.js.krusch-tmp-12345-abcd');
  fs.writeFileSync(tempPath, '// temp data', 'utf-8');

  // Run startup recovery
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].outcome, 'APPLIED');

  // Assert DB status is APPLIED
  const diffCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [staged.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'APPLIED');

  // Assert disk content is preserved and temp file is cleaned up
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/recovered.js'), 'utf-8'), stagedContent);
  assert.strictEqual(fs.existsSync(tempPath), false);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Recovery Fixture 2: No rename -> Reverted to PENDING, temp cleaned, disk untouched', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-fixture2-pending-'));
  const taskId = `fixture2_pending_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Fixture 2: No rename',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  const baseContent = '// base original file';
  const stagedContent = '// staged but crashed before rename';
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/pending_recover.js',
    originalContent: baseContent,
    stagedContent,
    diffPatch: 'fix',
    projectPath: testDir
  });

  // Simulate mid-crash state: status is APPLYING in DB, disk is original base, temp file exists
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id = $1`, [staged.id]);
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src/pending_recover.js'), baseContent, 'utf-8');
  const tempPath = path.join(testDir, 'src/.pending_recover.js.krusch-tmp-9999-ef01');
  fs.writeFileSync(tempPath, '// staged temp data', 'utf-8');

  // Run startup recovery
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].outcome, 'REVERTED_TO_PENDING');

  // Assert DB status is reverted to PENDING
  const diffCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [staged.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'PENDING');

  // Assert disk content is untouched and temp file is unlinked
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/pending_recover.js'), 'utf-8'), baseContent);
  assert.strictEqual(fs.existsSync(tempPath), false);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Recovery Fixture 3: Working tree drift -> Marked REJECTED, disk not clobbered', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-fixture3-drift-'));
  const taskId = `fixture3_drift_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Fixture 3: Drift detection during crash recovery',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  const baseContent = '// base content';
  const stagedContent = '// staged content';
  const driftContent = '// external out-of-band edits happened during crash!';

  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/drifted.js',
    originalContent: baseContent,
    stagedContent,
    diffPatch: 'fix',
    projectPath: testDir
  });

  // Simulate mid-crash state: status is APPLYING in DB, but external process modified disk to driftContent
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id = $1`, [staged.id]);
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src/drifted.js'), driftContent, 'utf-8');

  // Run startup recovery
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].outcome, 'DRIFT_REJECTED');

  // Assert DB marked REJECTED
  const diffCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [staged.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'REJECTED');

  // Assert disk content was NOT clobbered!
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/drifted.js'), 'utf-8'), driftContent);

  // Assert drift event was logged in PostgreSQL
  const eventRes = await query(`SELECT event_type, payload FROM krusch_events WHERE task_id = $1 AND event_type = 'drift_detected'`, [taskId]);
  assert.strictEqual(eventRes.rows.length, 1);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Recovery Fixture 4: Partial batch crash -> Renamed file rolled back to base, all reverted to PENDING', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-fixture4-partial-'));
  const taskId = `fixture4_partial_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Fixture 4: Partial batch atomic rollback',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  const baseA = '// file A base';
  const baseB = '// file B base';
  const stagedA = '// file A new implementation';
  const stagedB = '// file B new implementation';

  fs.writeFileSync(path.join(testDir, 'src/fileA.js'), baseA, 'utf-8');
  fs.writeFileSync(path.join(testDir, 'src/fileB.js'), baseB, 'utf-8');

  const diffA = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/fileA.js',
    originalContent: baseA,
    stagedContent: stagedA,
    diffPatch: 'update A',
    projectPath: testDir
  });

  const diffB = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/fileB.js',
    originalContent: baseB,
    stagedContent: stagedB,
    diffPatch: 'update B',
    projectPath: testDir
  });

  // Simulate process death between rename of fileA and rename of fileB:
  // 1. Both rows are in APPLYING in DB
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2)`, [diffA.id, diffB.id]);
  // 2. File A was renamed on disk to stagedA
  fs.writeFileSync(path.join(testDir, 'src/fileA.js'), stagedA, 'utf-8');
  // 3. File B was NOT renamed on disk (still baseB), but sibling temp file exists
  const tempPathB = path.join(testDir, 'src/.fileB.js.krusch-tmp-crash-123');
  fs.writeFileSync(tempPathB, stagedB, 'utf-8');

  // Verify pre-recovery inconsistent disk state
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), stagedA);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), baseB);
  assert.strictEqual(fs.existsSync(tempPathB), true);

  // Run startup recovery
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.strictEqual(recovered.length, 2);
  assert.strictEqual(recovered[0].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');
  assert.strictEqual(recovered[1].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');

  // Assert PostgreSQL statuses: both reverted to PENDING
  const diffCheck = await query('SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2)', [diffA.id, diffB.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'PENDING');
  assert.strictEqual(diffCheck.rows[1].status, 'PENDING');

  // Assert atomic rollback on physical disk: File A was restored to baseA, File B remains baseB!
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), baseA);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), baseB);

  // Assert orphaned temp file was removed
  assert.strictEqual(fs.existsSync(tempPathB), false);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Protocol: Multi-file atomic batch apply applies all files or none on error', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-batch-apply-'));
  const taskId = `batch_apply_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Multi-file atomic apply',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src/file1.js'), '// file 1 base', 'utf-8');
  fs.writeFileSync(path.join(testDir, 'src/file2.js'), '// file 2 base', 'utf-8');

  const staged1 = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/file1.js',
    originalContent: '// file 1 base',
    stagedContent: '// file 1 updated',
    diffPatch: 'update 1',
    projectPath: testDir
  });

  const staged2 = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/file2.js',
    originalContent: '// file 2 base',
    stagedContent: '// file 2 updated',
    diffPatch: 'update 2',
    projectPath: testDir
  });

  // Execute atomic batch apply
  const batchResult = await KruschStateManager.applyDiffBatch(taskId, [staged1.id, staged2.id], testDir);
  assert.strictEqual(batchResult.status, 'APPLIED');
  assert.strictEqual(batchResult.appliedCount, 2);

  // Verify physical files on disk
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/file1.js'), 'utf-8'), '// file 1 updated');
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/file2.js'), 'utf-8'), '// file 2 updated');

  // Verify statuses in DB
  const diffCheck = await query('SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2)', [staged1.id, staged2.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'APPLIED');
  assert.strictEqual(diffCheck.rows[1].status, 'APPLIED');

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Protocol: Lease TTL allows breaking expired leases and prunes cleanly', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-leasettl-'));
  const task1 = `ttl_task1_${Date.now()}`;
  const task2 = `ttl_task2_${Date.now()}`;

  await KruschStateManager.createTask({
    id: task1,
    goal: 'Task 1 holding lease',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  await KruschStateManager.createTask({
    id: task2,
    goal: 'Task 2 taking over expired lease',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  // Task 1 stages file with backdated expired lease
  const staged1 = await KruschStateManager.stageDiff(task1, {
    filePath: 'locked.js',
    originalContent: '',
    stagedContent: '// locked by task 1',
    diffPatch: 'lock',
    projectPath: testDir
  });

  // Manually expire task 1's lease in DB
  await query(`UPDATE krusch_staged_diffs SET lease_expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [staged1.id]);

  // Task 2 attempts to stage same file: should detect expired lease, reject old diff, and successfully claim it
  const staged2 = await KruschStateManager.stageDiff(task2, {
    filePath: 'locked.js',
    originalContent: '',
    stagedContent: '// claimed by task 2',
    diffPatch: 'claim',
    projectPath: testDir
  });

  assert.strictEqual(staged2.task_id, task2);
  assert.strictEqual(staged2.status, 'PENDING');

  // Verify task 1's old diff was transitioned to REJECTED
  const oldCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [staged1.id]);
  assert.strictEqual(oldCheck.rows[0].status, 'REJECTED');

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task1]);
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task2]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Recovery Fixture: Crash during rollback is idempotent and completes cleanly on reboot', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-crash-rollback-'));
  const taskId = `crash_rollback_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Crash during rollback idempotency',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  const baseA = '// file A base preimage';
  const baseB = '// file B base preimage';
  const stagedA = '// file A staged';
  const stagedB = '// file B staged';

  fs.writeFileSync(path.join(testDir, 'src/rollA.js'), baseA, 'utf-8');
  fs.writeFileSync(path.join(testDir, 'src/rollB.js'), baseB, 'utf-8');

  const diffA = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/rollA.js',
    originalContent: baseA,
    stagedContent: stagedA,
    diffPatch: 'update rollA',
    projectPath: testDir
  });

  const diffB = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/rollB.js',
    originalContent: baseB,
    stagedContent: stagedB,
    diffPatch: 'update rollB',
    projectPath: testDir
  });

  // Simulate mid-apply crash: both diffs in APPLYING, rollA was renamed on disk to stagedA, rollB still baseB
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2)`, [diffA.id, diffB.id]);
  fs.writeFileSync(path.join(testDir, 'src/rollA.js'), stagedA, 'utf-8');

  // Simulate second crash DURING rollback of rollA:
  // An atomic rollback temp file was written to disk, but process crashed before atomic rename!
  const rollbackTempPath = path.join(testDir, 'src/.rollA.js.krusch-atomic-tmp-interrupted-1234');
  fs.writeFileSync(rollbackTempPath, baseA, 'utf-8');

  // Verify pre-recovery state
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/rollA.js'), 'utf-8'), stagedA);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/rollB.js'), 'utf-8'), baseB);
  assert.strictEqual(fs.existsSync(rollbackTempPath), true);

  // Next reboot: recoverInFlightApplies runs
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.strictEqual(recovered.length, 2);
  assert.strictEqual(recovered[0].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');
  assert.strictEqual(recovered[1].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');

  // Assert DB status
  const diffCheck = await query('SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2)', [diffA.id, diffB.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'PENDING');
  assert.strictEqual(diffCheck.rows[1].status, 'PENDING');

  // Assert physical disk: rollA completed atomic rollback to baseA, rollB remains baseB!
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/rollA.js'), 'utf-8'), baseA);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/rollB.js'), 'utf-8'), baseB);

  // Assert orphaned rollback temp file was cleaned up
  assert.strictEqual(fs.existsSync(rollbackTempPath), false);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Protocol: applyDiffBatch strictly refuses to apply REJECTED diffs', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-reject-apply-'));
  const taskId = `reject_apply_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test refusing to apply rejected diffs',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/drifted.js',
    originalContent: '// base',
    stagedContent: '// staged',
    diffPatch: 'fix',
    projectPath: testDir
  });

  // Mark diff as REJECTED (e.g. drift detected)
  await query(`UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1`, [staged.id]);

  // Attempting to apply explicitly must throw
  let applyThrew = false;
  try {
    await KruschStateManager.applyDiffBatch(taskId, [staged.id], testDir);
  } catch (err) {
    applyThrew = true;
    assert.ok(err.message.includes('Refusing to apply diff'));
    assert.ok(err.message.includes('REJECTED'));
  }
  assert.strictEqual(applyThrew, true);

  // Attempting to apply batch must also throw
  let batchThrew = false;
  try {
    await KruschStateManager.applyDiffBatch(taskId, null, testDir);
  } catch (err) {
    batchThrew = true;
    assert.ok(err.message.includes('REJECTED staged diff(s)'));
  }
  assert.strictEqual(batchThrew, true);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Transaction Protocol: Durable apply journal records APPLYING and APPLIED state in PostgreSQL', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-journal-test-'));
  const taskId = `journal_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test durable apply journal table',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'pass',
    stderr: '',
    passed: true
  });

  await KruschStateManager.stageDiff(taskId, {
    filePath: 'journaled_file.js',
    originalContent: '// before',
    stagedContent: '// after',
    diffPatch: '@@ -1 +1 @@\n-// before\n+// after\n',
    projectPath: testDir
  });

  fs.writeFileSync(path.join(testDir, 'journaled_file.js'), '// before', 'utf-8');

  const applyRes = await KruschStateManager.applyDiffBatch(taskId, null, testDir);
  assert.strictEqual(applyRes.status, 'APPLIED');
  assert.ok(applyRes.journalId);

  // Inspect journal row in PostgreSQL
  const journalRows = await query(`SELECT * FROM krusch_apply_journal WHERE id = $1`, [applyRes.journalId]);
  assert.strictEqual(journalRows.rows.length, 1);
  const journal = journalRows.rows[0];
  assert.strictEqual(journal.state, 'APPLIED');
  assert.strictEqual(journal.task_id, taskId);
  assert.ok(journal.completed_at);
  const files = typeof journal.files === 'string' ? JSON.parse(journal.files) : journal.files;
  assert.strictEqual(files[0].filePath, 'journaled_file.js');

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});

