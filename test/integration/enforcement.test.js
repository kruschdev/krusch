import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pool, query } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { KruschFSM, HARNESS_PHASES } from '../../src/workflow/fsm.js';
import { KruschTools } from '../../src/tools/index.js';

test('Enforcement: Test suite runs against live PostgreSQL with active CHECK constraints', async () => {
  // Verify real PostgreSQL connection, not an in-memory mock
  const dbInfo = await query('SELECT current_database(), current_user, version()');
  assert.ok(dbInfo.rows.length > 0);
  assert.strictEqual(dbInfo.rows[0].current_database, 'kdcode');
  assert.ok(dbInfo.rows[0].version.includes('PostgreSQL 16'));

  // Verify DB-level CHECK constraints exist in PostgreSQL system catalogs
  const constraints = await query(`
    SELECT conname, pg_get_constraintdef(oid) as def
    FROM pg_constraint
    WHERE conrelid = 'krusch_tasks'::regclass AND conname = 'chk_krusch_tasks_phase'
  `);
  assert.strictEqual(constraints.rows.length, 1);
  assert.ok(constraints.rows[0].def.includes('INIT'));
  assert.ok(constraints.rows[0].def.includes('COMMITTED'));
});

test('Enforcement: In-database phase constraint rejects invalid phase mutations at SQL layer', async () => {
  const taskId = `bad_phase_${Date.now()}`;

  // Attempt direct SQL insert with bogus phase
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO krusch_tasks (id, goal, project_path, phase) VALUES ($1, $2, $3, $4)`,
        [taskId, 'Invalid phase test', process.cwd(), 'INVALID_NON_EXISTENT_PHASE']
      );
    },
    (err) => {
      assert.ok(err.message.includes('chk_krusch_tasks_phase') || err.message.includes('check constraint'));
      return true;
    }
  );
});

test('Enforcement: Latest verification run strictly respects chronological ordering (ORDER BY id DESC, created_at DESC)', async () => {
  const taskId = `enforce_order_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test chronological ordering inversion prevention',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.VERIFY
  });

  const fsm = new KruschFSM(taskId, HARNESS_PHASES.VERIFY);

  // Run 1 (Earlier): PASSED test run
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'All passed',
    stderr: '',
    passed: true
  });

  // Run 2 (Later): FAILED test run (regression introduced)
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 1,
    stdout: '',
    stderr: 'AssertionError: test failed',
    passed: false
  });

  // Verify getLatestVerificationRun returns Run 2 (failed), NOT Run 1 (passed)
  const latestRun = await KruschStateManager.getLatestVerificationRun(taskId);
  assert.strictEqual(latestRun.passed, false, 'Authoritative latest run must be Run 2 (failed)');
  assert.strictEqual(latestRun.exit_code, 1);

  // Transition to APPROVAL_GATE MUST be rejected because the latest run failed
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

  // Run 3 (Even Later): PASSED test run (regression fixed)
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'Tests fixed and passing',
    stderr: '',
    passed: true
  });

  // Now the latest run is Run 3 (passed)
  const newestRun = await KruschStateManager.getLatestVerificationRun(taskId);
  assert.strictEqual(newestRun.passed, true);
  assert.strictEqual(newestRun.exit_code, 0);

  // Transition to APPROVAL_GATE must now succeed
  const transitionResult = await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);
  assert.strictEqual(transitionResult.to, HARNESS_PHASES.APPROVAL_GATE);
  assert.strictEqual(fsm.currentPhase, HARNESS_PHASES.APPROVAL_GATE);
});

test('Enforcement: PLAN -> COMMITTED shortcut is strictly forbidden when staged diffs exist', async () => {
  const taskId = `enforce_plan_guard_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test PLAN -> COMMITTED shortcut guard',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.INIT
  });

  const fsm = new KruschFSM(taskId, HARNESS_PHASES.INIT);
  await fsm.transitionTo(HARNESS_PHASES.PLAN);

  // Stage a diff into PostgreSQL while in PLAN
  await KruschStateManager.stageDiff(taskId, {
    filePath: 'lib/core.js',
    originalContent: 'old code',
    stagedContent: 'new code',
    diffPatch: 'staged change'
  });

  // Attempting shortcut PLAN -> COMMITTED must be strictly rejected
  await assert.rejects(
    async () => {
      await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
    },
    (err) => {
      assert.ok(err.message.includes('Invariant Violation'));
      assert.ok(err.message.includes('Cannot shortcut from PLAN to COMMITTED while staged diffs exist'));
      return true;
    }
  );

  // State must remain in PLAN
  assert.strictEqual(fsm.currentPhase, HARNESS_PHASES.PLAN);
});

test('Enforcement: Crash-safe atomic apply (fsync + rename) in isolated temporary directory', async () => {
  const taskId = `enforce_atomic_apply_${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-test-apply-'));

  try {
    const targetRelFile = 'src/sub/output.txt';
    const targetAbsFile = path.resolve(tempDir, targetRelFile);

    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Test crash-safe atomic apply',
      projectPath: tempDir,
      phase: HARNESS_PHASES.VERIFY
    });

    const tools = new KruschTools(taskId, tempDir, { autoApprove: true });

    // 1. Stage diff into PostgreSQL
    const staged = await tools.executeTool('stage_diff', {
      path: targetRelFile,
      content: 'ATOMIC DURABLE CONTENT WRITTEN VIA FSYNC AND RENAME',
      explanation: 'Testing crash safety'
    });
    assert.strictEqual(staged.status, 'STAGED');
    assert.ok(staged.diffId);

    // 2. Verification fails: disk MUST NOT be touched
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 1,
      stdout: '',
      stderr: 'Build error',
      passed: false
    });

    const failedApply = await tools.executeTool('apply_staged_diff', { diffId: staged.diffId });
    assert.ok(failedApply.error);
    assert.strictEqual(fs.existsSync(targetAbsFile), false, 'Disk file MUST NOT exist on test failure');

    // 3. Verification passes and FSM transitions to APPROVAL_GATE
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'All checks green',
      stderr: '',
      passed: true
    });

    const fsm = new KruschFSM(taskId, HARNESS_PHASES.VERIFY);
    await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);

    // 4. Apply staged diff to disk
    const successApply = await tools.executeTool('apply_staged_diff', { diffId: staged.diffId });
    assert.strictEqual(successApply.status, 'APPLIED');
    assert.strictEqual(fs.existsSync(targetAbsFile), true, 'File must exist on disk after passing verification');
    assert.strictEqual(fs.readFileSync(targetAbsFile, 'utf-8'), 'ATOMIC DURABLE CONTENT WRITTEN VIA FSYNC AND RENAME');

    // 5. Invariant check: No orphaned temporary files left in directory
    const dirEntries = fs.readdirSync(path.dirname(targetAbsFile));
    const tmpFiles = dirEntries.filter(f => f.includes('krusch-tmp'));
    assert.strictEqual(tmpFiles.length, 0, 'No temporary files should be left behind after atomic rename');

    // 6. Check PostgreSQL staged diff row updated with applied_at
    const diffRows = await KruschStateManager.getPendingDiffs(taskId);
    assert.strictEqual(diffRows.length, 0, 'Pending diffs must now be empty');

    const taskRecord = await KruschStateManager.getTask(taskId);
    const appliedDiff = taskRecord.stagedDiffs.find(d => d.id === staged.diffId);
    assert.strictEqual(appliedDiff.status, 'APPLIED');
    assert.ok(appliedDiff.applied_at, 'applied_at timestamp must be set in PostgreSQL');

    // 7. Transition to COMMITTED must succeed
    await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
    assert.strictEqual(fsm.currentPhase, HARNESS_PHASES.COMMITTED);
  } finally {
    // Clean up temporary test directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Enforcement: Database trigger rejects illegal phase transitions at PostgreSQL catalog level', async () => {
  const taskId = `trg_test_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test PostgreSQL trigger-enforced FSM transitions',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.INIT
  });

  // 1. Attempt illegal transition directly via raw SQL: INIT -> COMMITTED
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('Invalid FSM transition: cannot transition from INIT to COMMITTED'));
      return true;
    }
  );

  // 2. Legal transition: INIT -> PLAN
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.PLAN, taskId]);
  const taskAfterPlan = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskAfterPlan.phase, HARNESS_PHASES.PLAN);

  // 3. Attempt illegal transition directly via raw SQL: PLAN -> VERIFY (skipping IMPLEMENT)
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.VERIFY, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('Invalid FSM transition: cannot transition from PLAN to VERIFY'));
      return true;
    }
  );

  // 4. Legal transition: PLAN -> COMMITTED (for read-only tasks)
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  const taskAfterCommit = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskAfterCommit.phase, HARNESS_PHASES.COMMITTED);

  // 5. Attempt illegal mutation from terminal state: COMMITTED -> PLAN
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.PLAN, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('Terminal state: cannot transition from terminal phase COMMITTED'));
      return true;
    }
  );
});

test('Enforcement: apply_staged_diff detects working tree drift and blocks overwrite', async () => {
  const taskId = `drift_test_${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-test-drift-'));

  try {
    const targetRelFile = 'config.json';
    const targetAbsFile = path.resolve(tempDir, targetRelFile);

    // Initial file state
    const originalFileContent = JSON.stringify({ version: '1.0.0', env: 'production' }, null, 2);
    fs.writeFileSync(targetAbsFile, originalFileContent, 'utf-8');

    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Test working tree drift detection',
      projectPath: tempDir,
      phase: HARNESS_PHASES.VERIFY
    });

    const tools = new KruschTools(taskId, tempDir, { autoApprove: true });

    // 1. Stage diff based on original content
    const staged = await tools.executeTool('stage_diff', {
      path: targetRelFile,
      content: JSON.stringify({ version: '2.0.0', env: 'production' }, null, 2),
      explanation: 'Upgrade version'
    });
    assert.strictEqual(staged.status, 'STAGED');

    // 2. Simulate passing verification run and transition to APPROVAL_GATE
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'All checks green',
      stderr: '',
      passed: true
    });

    const fsm = new KruschFSM(taskId, HARNESS_PHASES.VERIFY);
    await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);

    // 3. SIMULATE OUT-OF-BAND DISK MODIFICATION (Working Tree Drift)
    // External user or process edits config.json while agent is in verification
    const driftedContent = JSON.stringify({ version: '1.0.0', env: 'staging', uncommittedChange: true }, null, 2);
    fs.writeFileSync(targetAbsFile, driftedContent, 'utf-8');

    // 4. Attempt to apply staged diff - MUST FAIL with WORKING_TREE_DRIFT_DETECTED
    const driftResult = await tools.executeTool('apply_staged_diff', { diffId: staged.diffId });
    assert.ok(driftResult.error, 'Should return error on disk drift');
    assert.strictEqual(driftResult.error, 'WORKING_TREE_DRIFT_DETECTED');
    assert.ok(driftResult.message.includes('working tree file'));

    // Invariant check: disk content MUST NOT have been overwritten!
    assert.strictEqual(
      fs.readFileSync(targetAbsFile, 'utf-8'),
      driftedContent,
      'Live disk content must remain untouched after drift detection'
    );

    // 5. Restore disk content to original staged base
    fs.writeFileSync(targetAbsFile, originalFileContent, 'utf-8');

    // 6. Now apply should succeed
    const validApply = await tools.executeTool('apply_staged_diff', { diffId: staged.diffId });
    assert.strictEqual(validApply.status, 'APPLIED');
    assert.strictEqual(
      fs.readFileSync(targetAbsFile, 'utf-8'),
      JSON.stringify({ version: '2.0.0', env: 'production' }, null, 2)
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await pool.end();
});
