import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pool, query } from '../../src/brain/pool.js';
import { KruschStateManager, canonicalizePaths } from '../../src/brain/state-manager.js';
import { KruschFSM, HARNESS_PHASES } from '../../src/workflow/fsm.js';
import { KruschTools } from '../../src/tools/index.js';

test('Enforcement: Test suite runs against live PostgreSQL with active CHECK constraints', async () => {
  // Verify real PostgreSQL connection, not an in-memory mock
  const dbInfo = await query('SELECT current_database(), current_user, version()');
  assert.ok(dbInfo.rows.length > 0);
  assert.ok(dbInfo.rows[0].current_database === 'kdcode' || dbInfo.rows[0].current_database === 'krusch');
  assert.ok(dbInfo.rows[0].version.includes('PostgreSQL 16'));

  // Verify DB-level CHECK constraints exist in PostgreSQL system catalogs
  const constraints = await query(`
    SELECT conname, pg_get_constraintdef(oid) as def
    FROM pg_constraint
    WHERE conrelid = 'krusch_tasks'::regclass AND conname IN ('chk_krusch_tasks_phase', 'krusch_tasks_phase_check')
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
        err.message.includes('idx_krusch_staged_diffs_project_file_active') ||
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
      assert.ok(
        err.message.includes('idx_krusch_staged_diffs_project_file_active') ||
        err.message.includes('idx_krusch_staged_diffs_project_file_pending') ||
        err.message.includes('duplicate key value')
      );
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
  assert.ok(versions.includes('003_phase_edges_and_lease_hardening'));
  assert.ok(versions.includes('004_lease_lifecycle_and_path_canonicalization'));
});

test('Enforcement: Path canonicalization prevents lease bypass across relative, absolute, and dot-dot spellings', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-canon-test-'));
  const subDir = path.join(testDir, 'src', 'modules');
  fs.mkdirSync(subDir, { recursive: true });

  const task1 = `canon_task_1_${Date.now()}`;
  const task2 = `canon_task_2_${Date.now()}`;
  const task3 = `canon_task_3_${Date.now()}`;

  await KruschStateManager.createTask({
    id: task1,
    goal: 'Canonicalization Test Task 1',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  await KruschStateManager.createTask({
    id: task2,
    goal: 'Canonicalization Test Task 2',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  await KruschStateManager.createTask({
    id: task3,
    goal: 'Canonicalization Test Task 3',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  // Task 1 stages using relative path with dot-slash: './src/modules/index.js'
  const staged1 = await KruschStateManager.stageDiff(task1, {
    filePath: './src/modules/index.js',
    originalContent: '',
    stagedContent: 'console.log("task 1");',
    diffPatch: 'add file',
    projectPath: testDir
  });
  assert.strictEqual(staged1.file_path, 'src/modules/index.js', 'File path must be normalized without leading ./');

  // Task 2 attempts to stage using clean relative path: 'src/modules/index.js' -> MUST FAIL
  await assert.rejects(
    async () => {
      await KruschStateManager.stageDiff(task2, {
        filePath: 'src/modules/index.js',
        originalContent: '',
        stagedContent: 'console.log("task 2 collision");',
        diffPatch: 'task 2',
        projectPath: testDir
      });
    },
    (err) => {
      assert.ok(err.message.includes('CONCURRENCY_LEASE_CONFLICT'));
      return true;
    }
  );

  // Task 2 attempts to stage using absolute path: path.join(testDir, 'src/modules/index.js') -> MUST FAIL
  await assert.rejects(
    async () => {
      await KruschStateManager.stageDiff(task2, {
        filePath: path.join(testDir, 'src', 'modules', 'index.js'),
        originalContent: '',
        stagedContent: 'console.log("task 2 absolute collision");',
        diffPatch: 'task 2 abs',
        projectPath: testDir
      });
    },
    (err) => {
      assert.ok(err.message.includes('CONCURRENCY_LEASE_CONFLICT'));
      return true;
    }
  );

  // Task 2 attempts to stage using dot-dot path: 'src/../src/modules/index.js' -> MUST FAIL
  await assert.rejects(
    async () => {
      await KruschStateManager.stageDiff(task2, {
        filePath: 'src/../src/modules/index.js',
        originalContent: '',
        stagedContent: 'console.log("task 2 dot-dot collision");',
        diffPatch: 'task 2 dot-dot',
        projectPath: testDir
      });
    },
    (err) => {
      assert.ok(err.message.includes('CONCURRENCY_LEASE_CONFLICT'));
      return true;
    }
  );

  // Direct SQL insert with raw non-canonical path into PostgreSQL trigger: trigger normalizes and rejects via unique index
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO krusch_staged_diffs (task_id, project_path, file_path, staged_content, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [task3, testDir, './src/modules/index.js', '// raw SQL']
      );
    },
    (err) => {
      assert.ok(
        err.message.includes('idx_krusch_staged_diffs_project_file_active') ||
        err.message.includes('duplicate key value')
      );
      return true;
    }
  );

  // Abort tasks and cleanup
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task1]);
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task2]);
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task3]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Enforcement: Lease is held across APPLIED status through APPROVAL_GATE until COMMITTED', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-lease-active-test-'));
  const sharedFile = 'src/service.js';

  const taskA = `lease_task_a_${Date.now()}`;
  const taskB = `lease_task_b_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskA,
    goal: 'Task A working through lifecycle',
    projectPath: testDir,
    phase: HARNESS_PHASES.VERIFY
  });

  await KruschStateManager.createTask({
    id: taskB,
    goal: 'Task B waiting for publication',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  // Task A stages file
  const stagedA = await KruschStateManager.stageDiff(taskA, {
    filePath: sharedFile,
    originalContent: '',
    stagedContent: 'export const service = "A";',
    diffPatch: 'Task A staged',
    projectPath: testDir
  });

  // Task A passes verification and moves to APPROVAL_GATE
  await KruschStateManager.recordVerificationRun(taskA, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'OK',
    stderr: '',
    passed: true
  });
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.APPROVAL_GATE, taskA]);

  // Task A applies staged diff to disk -> status becomes APPLIED
  await KruschStateManager.updateDiffStatus(stagedA.id, 'APPLIED');
  const appliedCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [stagedA.id]);
  assert.strictEqual(appliedCheck.rows[0].status, 'APPLIED');

  // Task B attempts to stage the same file while Task A is still in APPROVAL_GATE: MUST BE BLOCKED!
  await assert.rejects(
    async () => {
      await KruschStateManager.stageDiff(taskB, {
        filePath: sharedFile,
        originalContent: '',
        stagedContent: 'export const service = "B";',
        diffPatch: 'Task B attempting collision',
        projectPath: testDir
      });
    },
    (err) => {
      assert.ok(
        err.message.includes('CONCURRENCY_LEASE_CONFLICT') ||
        err.message.includes('idx_krusch_staged_diffs_project_file_active')
      );
      return true;
    }
  );

  // Raw SQL from Task B while status is APPLIED must also be blocked by PostgreSQL index
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO krusch_staged_diffs (task_id, project_path, file_path, staged_content, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [taskB, testDir, sharedFile, 'conflict']
      );
    },
    (err) => {
      assert.ok(err.message.includes('idx_krusch_staged_diffs_project_file_active'));
      return true;
    }
  );

  // Task A transitions to COMMITTED: database trigger automatically updates status to COMMITTED, releasing lease!
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskA]);
  const committedCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [stagedA.id]);
  assert.strictEqual(committedCheck.rows[0].status, 'COMMITTED', 'Diff status must automatically promote to COMMITTED upon task commit');

  // Task B can now successfully stage the file!
  const stagedB = await KruschStateManager.stageDiff(taskB, {
    filePath: sharedFile,
    originalContent: 'export const service = "A";',
    stagedContent: 'export const service = "B";',
    diffPatch: 'Task B now succeeds',
    projectPath: testDir
  });
  assert.strictEqual(stagedB.status, 'PENDING');

  // Clean up
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskB]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Enforcement: Single source of truth for legal graph via krusch_phase_edges', async () => {
  // Query edges directly from PostgreSQL catalog table
  const dbEdges = await query('SELECT from_phase, to_phase FROM krusch_phase_edges ORDER BY from_phase, to_phase');
  assert.ok(dbEdges.rows.length >= 13);

  // Verify KruschFSM loads edges dynamically
  const loadedGraph = await KruschFSM.loadAllowedTransitions();
  assert.ok(loadedGraph[HARNESS_PHASES.INIT].includes(HARNESS_PHASES.PLAN));
  assert.ok(loadedGraph[HARNESS_PHASES.PLAN].includes(HARNESS_PHASES.IMPLEMENT));
  assert.ok(loadedGraph[HARNESS_PHASES.VERIFY].includes(HARNESS_PHASES.APPROVAL_GATE));
  assert.ok(loadedGraph[HARNESS_PHASES.APPROVAL_GATE].includes(HARNESS_PHASES.COMMITTED));

  // Verify that an invalid edge not in krusch_phase_edges is rejected by both JS and DB trigger
  const taskId = `edge_test_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test graph edge rejection',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.INIT
  });

  const fsm = new KruschFSM(taskId, HARNESS_PHASES.INIT);
  assert.strictEqual(fsm.canTransitionTo(HARNESS_PHASES.COMMITTED), false);

  // Attempt transition via raw SQL: trigger rejects consulting krusch_phase_edges
  await assert.rejects(
    async () => {
      await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.COMMITTED, taskId]);
    },
    (err) => {
      assert.ok(err.message.includes('Invalid FSM transition'));
      return true;
    }
  );

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
});

test('Enforcement: Task row locking serializes concurrent verification runs and phase transitions', async () => {
  const taskId = `lock_task_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Task row locking test',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.VERIFY
  });

  // Verify recordVerificationRun executes with row lock
  const run1 = await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm test',
    exitCode: 0,
    stdout: 'Tests passed',
    stderr: '',
    passed: true
  });
  assert.strictEqual(run1.passed, true);

  // Verify recordVerificationAndTransition atomically records test and transitions phase
  const runAndTransition = await KruschStateManager.recordVerificationAndTransition(
    taskId,
    {
      command: 'npm test',
      exitCode: 0,
      stdout: 'All green',
      stderr: '',
      passed: true
    },
    HARNESS_PHASES.APPROVAL_GATE,
    { verifiedBy: 'atomic_runner' }
  );

  assert.strictEqual(runAndTransition.verificationRun.passed, true);
  assert.strictEqual(runAndTransition.transition.to, HARNESS_PHASES.APPROVAL_GATE);

  const updatedTask = await KruschStateManager.getTask(taskId);
  assert.strictEqual(updatedTask.phase, HARNESS_PHASES.APPROVAL_GATE);

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
});

test('Enforcement: Path canonicalization resolves a/../b to b in PostgreSQL and triggers unique lease collision', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-dotdot-test-'));
  const task1 = `dotdot_task_1_${Date.now()}`;
  const task2 = `dotdot_task_2_${Date.now()}`;

  await KruschStateManager.createTask({
    id: task1,
    goal: 'Dot-dot task 1',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  await KruschStateManager.createTask({
    id: task2,
    goal: 'Dot-dot task 2',
    projectPath: testDir,
    phase: HARNESS_PHASES.PLAN
  });

  // Task 1 stages 'b'
  const staged1 = await KruschStateManager.stageDiff(task1, {
    filePath: 'b',
    originalContent: '',
    stagedContent: '// file b',
    diffPatch: 'add b',
    projectPath: testDir
  });
  assert.strictEqual(staged1.file_path, 'b');

  // Task 2 attempts to stage 'a/../b' via stageDiff -> MUST FAIL
  await assert.rejects(
    async () => {
      await KruschStateManager.stageDiff(task2, {
        filePath: 'a/../b',
        originalContent: '',
        stagedContent: '// file b collided',
        diffPatch: 'collide b',
        projectPath: testDir
      });
    },
    (err) => {
      assert.ok(
        err.message.includes('CONCURRENCY_LEASE_CONFLICT') ||
        err.message.includes('idx_krusch_staged_diffs_project_file_active')
      );
      return true;
    }
  );

  // Raw SQL insert with 'a/../b' directly into PostgreSQL -> trigger normalizes to 'b' and collides on active index
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO krusch_staged_diffs (task_id, project_path, file_path, staged_content, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [task2, testDir, 'a/../b', '// raw SQL a/../b']
      );
    },
    (err) => {
      assert.ok(
        err.message.includes('idx_krusch_staged_diffs_project_file_active') ||
        err.message.includes('duplicate key value')
      );
      return true;
    }
  );

  // Raw SQL insert attempting to escape repo root with '..' -> trigger rejects with check_violation
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO krusch_staged_diffs (task_id, project_path, file_path, staged_content, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [task2, testDir, '../../etc/passwd', '// exploit attempt']
      );
    },
    (err) => {
      assert.ok(
        err.message.includes('path cannot escape repo root') ||
        err.message.includes('check constraint') ||
        err.code === '23514'
      );
      return true;
    }
  );

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task1]);
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, task2]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Enforcement: Diff COMMITTED status strictly implies parent task is in COMMITTED phase', async () => {
  const taskId = `diff_committed_guard_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Guard diff committed status',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN
  });

  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'test/sample.js',
    originalContent: '',
    stagedContent: '// staged',
    diffPatch: 'staged',
    projectPath: process.cwd()
  });

  // Attempt direct SQL update of diff to COMMITTED while task is still in PLAN: MUST BE REJECTED
  await assert.rejects(
    async () => {
      await query(`UPDATE krusch_staged_diffs SET status = 'COMMITTED' WHERE id = $1`, [staged.id]);
    },
    (err) => {
      assert.ok(err.message.includes('Invariant Violation'));
      assert.ok(err.message.includes('must be COMMITTED'));
      return true;
    }
  );

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
});

test('Enforcement: Lease management is cleanly decoupled to AFTER UPDATE trigger', async () => {
  const taskId = `decoupled_trigger_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test decoupled AFTER UPDATE trigger',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN
  });

  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/lease_decoupled.js',
    originalContent: '',
    stagedContent: '// decoupled',
    diffPatch: 'decoupled test',
    projectPath: process.cwd()
  });

  // Check triggers on krusch_tasks: BEFORE trigger handles validation, AFTER trigger handles lease release
  const triggers = await query(`
    SELECT tgname, tgtype
    FROM pg_trigger
    WHERE tgrelid = 'krusch_tasks'::regclass AND tgname IN ('trg_krusch_task_phase_transition', 'trg_manage_krusch_task_phase_leases')
    ORDER BY tgname ASC;
  `);
  assert.strictEqual(triggers.rows.length, 2);

  // Transition to ABORTED: AFTER trigger releases lease to REJECTED
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  const diffCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [staged.id]);
  assert.strictEqual(diffCheck.rows[0].status, 'REJECTED');
});

test('Enforcement: Backfill safety preserves active leases for in-flight tasks (PLAN/VERIFY/IMPLEMENT)', async () => {
  const inFlightTask = `inflight_task_${Date.now()}`;
  const abortedTask = `aborted_task_${Date.now()}`;

  await KruschStateManager.createTask({
    id: inFlightTask,
    goal: 'In-flight work in progress',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.IMPLEMENT
  });

  await KruschStateManager.createTask({
    id: abortedTask,
    goal: 'Dead task aborted previously',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.ABORTED
  });

  const stagedInFlight = await KruschStateManager.stageDiff(inFlightTask, {
    filePath: 'src/live_work.js',
    originalContent: '',
    stagedContent: '// valuable in-flight code',
    diffPatch: 'feature',
    projectPath: process.cwd()
  });

  // Directly insert a staged diff for the aborted task to simulate legacy state before migration
  const abortedDiffRes = await query(
    `INSERT INTO krusch_staged_diffs (task_id, project_path, file_path, staged_content, status)
     VALUES ($1, $2, $3, $4, 'PENDING') RETURNING id`,
    [abortedTask, process.cwd(), 'src/dead_work.js', '// dead code']
  );
  const abortedDiffId = abortedDiffRes.rows[0].id;

  // Execute the safe backfill logic from migration 003
  await query(`
    UPDATE krusch_staged_diffs d
    SET status = 'REJECTED'
    FROM krusch_tasks t
    WHERE d.task_id = t.id AND t.phase = 'ABORTED' AND d.status IN ('PENDING', 'APPLIED');
  `);

  // Verify in-flight task's staged diff is UNTOUCHED (PENDING), NOT rejected
  const inFlightCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [stagedInFlight.id]);
  assert.strictEqual(inFlightCheck.rows[0].status, 'PENDING', 'In-flight staged work must never be marked REJECTED by migration backfill');

  // Verify aborted task's staged diff was properly marked REJECTED
  const abortedCheck = await query('SELECT status FROM krusch_staged_diffs WHERE id = $1', [abortedDiffId]);
  assert.strictEqual(abortedCheck.rows[0].status, 'REJECTED', 'Aborted task staged diff must be cleaned up to REJECTED');

  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, inFlightTask]);
});

test('Invariant Test (b): IMPLEMENT cannot jump to COMMITTED with pending diffs even via updateTask', async () => {
  const taskId = `enforce_impl_commit_${Date.now()}`;
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test direct updateTask bypass prevention from IMPLEMENT to COMMITTED',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.PLAN
  });

  // Advance task legitimately from PLAN to IMPLEMENT
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.IMPLEMENT });

  // Stage a diff into PostgreSQL (status: PENDING)
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/pending_bypass_attempt.js',
    originalContent: '',
    stagedContent: '// unverified staged code',
    diffPatch: '+ // unverified staged code',
    projectPath: process.cwd()
  });
  assert.strictEqual(staged.status, 'PENDING');

  // Attempt direct illegal bypass via updateTask: IMPLEMENT -> COMMITTED
  await assert.rejects(
    async () => {
      await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
    },
    (err) => {
      assert.ok(
        err.message.includes('Invalid FSM transition: cannot transition from IMPLEMENT to COMMITTED'),
        `Expected Invalid FSM transition error, got: ${err.message}`
      );
      return true;
    }
  );

  // Verify task phase is still IMPLEMENT and diff is still PENDING
  const taskAfter = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskAfter.phase, HARNESS_PHASES.IMPLEMENT, 'Task phase must remain IMPLEMENT');

  // Clean up
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.ABORTED });
});

test.after(async () => {
  await pool.end();
});
