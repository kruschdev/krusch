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
    filePath: `lib/core_${taskId}.js`,
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

  // Abort task to release pending lease in database
  await fsm.transitionTo(HARNESS_PHASES.ABORTED);
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

test('Enforcement: Database trigger enforces verification invariant on VERIFY -> APPROVAL_GATE via raw SQL', async () => {
  const taskId = `trg_verif_gate_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test SQL-level verification gate',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.VERIFY
  });

  // 1. Attempt raw SQL transition to APPROVAL_GATE with ZERO verification runs: MUST FAIL
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('without running at least one verification test'));
      return true;
    }
  );

  // 2. Record a FAILED verification run
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 1,
    stdout: '',
    stderr: 'Test suite failed',
    passed: false
  });

  // Attempt raw SQL transition when latest run failed: MUST FAIL
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('while ground-truth verification is failing'));
      return true;
    }
  );

  // 3. Record a PASSING verification run
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'All green',
    stderr: '',
    passed: true
  });

  // Attempt raw SQL transition now: MUST SUCCEED
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);
  const task = await KruschStateManager.getTask(taskId);
  assert.strictEqual(task.phase, HARNESS_PHASES.APPROVAL_GATE);

  // Cleanly abort to conclude test
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
});

test('Enforcement: Database trigger enforces PLAN -> COMMITTED shortcut guard via raw SQL', async () => {
  const taskId = `trg_plan_shortcut_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test SQL-level PLAN -> COMMITTED shortcut guard',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN
  });

  // Stage a diff for this task
  await KruschStateManager.stageDiff(taskId, {
    filePath: `tmp/file_${Date.now()}.js`,
    originalContent: '',
    stagedContent: 'console.log("hello");',
    diffPatch: 'new file'
  });

  // Attempt raw SQL shortcut PLAN -> COMMITTED: MUST FAIL at trigger level
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('Cannot shortcut from PLAN to COMMITTED while staged diffs exist'));
      return true;
    }
  );

  // Abort task to release staged diff lease
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
});

test('Enforcement: Database trigger enforces APPROVAL_GATE -> COMMITTED guard via raw SQL', async () => {
  const taskId = `trg_gate_commit_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test SQL-level APPROVAL_GATE -> COMMITTED pending diff guard',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.VERIFY
  });

  // Stage diff
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: `tmp/gate_file_${Date.now()}.js`,
    originalContent: '',
    stagedContent: 'code',
    diffPatch: 'patch'
  });

  // Pass verification
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'Pass',
    stderr: '',
    passed: true
  });

  // Transition to APPROVAL_GATE
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);

  // Attempt to transition to COMMITTED while diff is still PENDING: MUST FAIL
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('while unapplied staged diffs remain PENDING'));
      return true;
    }
  );

  // Mark diff as APPLIED
  await KruschStateManager.updateDiffStatus(staged.id, 'APPLIED');

  // Transition to COMMITTED: MUST SUCCEED now that no pending diffs remain
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
  const task = await KruschStateManager.getTask(taskId);
  assert.strictEqual(task.phase, HARNESS_PHASES.COMMITTED);
});

test('Enforcement: Database trigger prevents marking diff APPLIED unless task is in APPROVAL_GATE with passing tests', async () => {
  const taskId = `trg_diff_apply_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test SQL-level staged diff apply guard',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN
  });

  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: `tmp/apply_guard_${Date.now()}.js`,
    originalContent: '',
    stagedContent: 'content',
    diffPatch: 'patch'
  });

  // Attempt to mark as APPLIED while task is in PLAN: MUST FAIL
  await assert.rejects(
    async () => {
      await query("UPDATE krusch_staged_diffs SET status = 'APPLIED' WHERE id = $1", [staged.id]);
    },
    (err) => {
      assert.ok(err.message.includes('must be APPROVAL_GATE'));
      return true;
    }
  );

  // Transition to VERIFY
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.IMPLEMENT, taskId]);
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.VERIFY, taskId]);

  // Attempt to mark as APPLIED while in VERIFY: MUST FAIL
  await assert.rejects(
    async () => {
      await query("UPDATE krusch_staged_diffs SET status = 'APPLIED' WHERE id = $1", [staged.id]);
    },
    (err) => {
      assert.ok(err.message.includes('must be APPROVAL_GATE'));
      return true;
    }
  );

  // Record passing verification and enter APPROVAL_GATE
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'Passed',
    stderr: '',
    passed: true
  });
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskId]);

  // Now marking as APPLIED: MUST SUCCEED
  await query("UPDATE krusch_staged_diffs SET status = 'APPLIED' WHERE id = $1", [staged.id]);
  const diffs = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [staged.id]);
  assert.strictEqual(diffs.rows[0].status, 'APPLIED');

  // Finish task
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
});

test('Enforcement: Single-writer file concurrency lease prevents concurrent conflicting pending diffs', async () => {
  const projectPath = `/tmp/krusch-concurrency-test-${Date.now()}`;
  const sharedFilePath = 'src/shared-module.js';

  const taskA = `task_a_${Date.now()}`;
  const taskB = `task_b_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskA,
    goal: 'Task A editing shared file',
    projectPath,
    phase: HARNESS_PHASES.PLAN
  });

  await KruschStateManager.createTask({
    id: taskB,
    goal: 'Task B attempting concurrent modification',
    projectPath,
    phase: HARNESS_PHASES.PLAN
  });

  // 1. Task A stages shared file: succeeds and holds lease
  const stagedA = await KruschStateManager.stageDiff(taskA, {
    filePath: sharedFilePath,
    originalContent: '// initial',
    stagedContent: '// version by Task A',
    diffPatch: 'edit A',
    projectPath
  });
  assert.strictEqual(stagedA.status, 'PENDING');

  // 2. Task B attempts to stage same file in same project: MUST FAIL due to concurrency lease
  await assert.rejects(
    async () => {
      await KruschStateManager.stageDiff(taskB, {
        filePath: sharedFilePath,
        originalContent: '// initial',
        stagedContent: '// version by Task B (collision)',
        diffPatch: 'edit B',
        projectPath
      });
    },
    (err) => {
      assert.ok(
        err.message.includes('CONCURRENCY_LEASE_CONFLICT') ||
        err.message.includes('idx_krusch_staged_diffs_project_file_pending')
      );
      return true;
    }
  );

  // Also verify raw SQL insert from Task B is rejected directly by PostgreSQL unique index
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO krusch_staged_diffs (task_id, project_path, file_path, staged_content, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [taskB, projectPath, sharedFilePath, '// raw SQL conflict']
      );
    },
    (err) => {
      assert.ok(err.message.includes('idx_krusch_staged_diffs_project_file_pending'));
      return true;
    }
  );

  // 3. Task A updates its own staged diff: MUST SUCCEED (re-staging by same task updates in place)
  const stagedA2 = await KruschStateManager.stageDiff(taskA, {
    filePath: sharedFilePath,
    originalContent: '// initial',
    stagedContent: '// version by Task A - iteration 2',
    diffPatch: 'edit A revision',
    projectPath
  });
  assert.strictEqual(stagedA2.id, stagedA.id);
  assert.strictEqual(stagedA2.staged_content, '// version by Task A - iteration 2');

  // 4. Task A is aborted: releases lease
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskA]);

  // Verify Task A's staged diff status was automatically changed to REJECTED by trigger
  const diffCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [stagedA.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'REJECTED');

  // 5. Task B can now successfully stage the file
  const stagedB = await KruschStateManager.stageDiff(taskB, {
    filePath: sharedFilePath,
    originalContent: '// initial',
    stagedContent: '// version by Task B now that lease is free',
    diffPatch: 'edit B succeeding',
    projectPath
  });
  assert.strictEqual(stagedB.status, 'PENDING');

  // Clean up Task B
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskB]);
});

test('Enforcement: Default task phase in PostgreSQL is INIT when omitted on INSERT', async () => {
  const taskId = `default_phase_${Date.now()}`;
  await query(
    'INSERT INTO krusch_tasks (id, goal, project_path) VALUES ($1, $2, $3)',
    [taskId, 'Test default phase', process.cwd()]
  );

  const res = await query('SELECT phase FROM krusch_tasks WHERE id = $1', [taskId]);
  assert.strictEqual(res.rows[0].phase, 'INIT', 'Column default must be INIT');

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
});

test('Enforcement: Versioned migration catalog tracks applied migrations', async () => {
  const res = await query('SELECT version FROM krusch_schema_migrations ORDER BY version ASC');
  const versions = res.rows.map(r => r.version);
  assert.ok(versions.includes('001_initial_schema'));
  assert.ok(versions.includes('002_harden_invariants'));
});

test.after(async () => {
  await pool.end();
});
