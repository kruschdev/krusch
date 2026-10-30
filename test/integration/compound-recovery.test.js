import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { query, withTransaction, pool } from '../../src/brain/pool.js';
import {
  KruschStateManager,
  atomicWriteFile,
  fsyncDirectory
} from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

function makeErrno(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * Wraps Node's `fs` module to track open file descriptors and inject deterministic faults.
 */
function createFaultFs(hooks = {}) {
  const openFds = new Set();

  const fsOps = {
    ...fs,
    mkdirSync: (...args) => (hooks.mkdirSync ? hooks.mkdirSync(fs, ...args) : fs.mkdirSync(...args)),
    existsSync: (...args) => (hooks.existsSync ? hooks.existsSync(fs, ...args) : fs.existsSync(...args)),
    readFileSync: (...args) => (hooks.readFileSync ? hooks.readFileSync(fs, ...args) : fs.readFileSync(...args)),
    readdirSync: (...args) => (hooks.readdirSync ? hooks.readdirSync(fs, ...args) : fs.readdirSync(...args)),
    writeFileSync: (...args) => (hooks.writeFileSync ? hooks.writeFileSync(fs, ...args) : fs.writeFileSync(...args)),
    openSync: (...args) => {
      const fd = hooks.openSync ? hooks.openSync(fs, ...args) : fs.openSync(...args);
      openFds.add(fd);
      return fd;
    },
    writeSync: (fd, ...args) => {
      if (hooks.writeSync) {
        return hooks.writeSync(fs, fd, ...args);
      }
      return fs.writeSync(fd, ...args);
    },
    fsyncSync: (fd, ...args) => {
      if (hooks.fsyncSync) {
        return hooks.fsyncSync(fs, fd, ...args);
      }
      return fs.fsyncSync(fd, ...args);
    },
    closeSync: (fd, ...args) => {
      openFds.delete(fd);
      if (hooks.closeSync) {
        return hooks.closeSync(fs, fd, ...args);
      }
      return fs.closeSync(fd, ...args);
    },
    renameSync: (...args) => {
      if (hooks.renameSync) {
        return hooks.renameSync(fs, ...args);
      }
      return fs.renameSync(...args);
    },
    unlinkSync: (...args) => {
      if (hooks.unlinkSync) {
        return hooks.unlinkSync(fs, ...args);
      }
      return fs.unlinkSync(...args);
    }
  };

  return { fsOps, openFds };
}

test('Filesystem Primitives: fsyncDirectory and atomicWriteFile close fds and clean temp files on I/O faults', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-fs-primitives-'));
  try {
    // 1. fsyncDirectory tolerates benign non-supported codes and closes fd
    for (const benignCode of ['EINVAL', 'EBADF', 'EISDIR', 'ENOTSUP', 'EPERM']) {
      const { fsOps, openFds } = createFaultFs({
        fsyncSync: () => {
          throw makeErrno(benignCode, 'directory fsync unsupported');
        }
      });
      fsyncDirectory(testDir, fsOps);
      assert.strictEqual(openFds.size, 0, `fd leaked when fsyncDirectory tolerated ${benignCode}`);
    }

    // 2. fsyncDirectory propagates genuine EIO while still closing fd
    {
      const { fsOps, openFds } = createFaultFs({
        fsyncSync: () => {
          throw makeErrno('EIO', 'physical media read/write failure');
        }
      });
      assert.throws(() => fsyncDirectory(testDir, fsOps), (err) => err.code === 'EIO');
      assert.strictEqual(openFds.size, 0, 'fd must be closed even when fsyncDirectory throws EIO');
    }

    // 3. atomicWriteFile closes fd, unlinks partial temp sibling, and preserves target on ENOSPC
    const targetFile = path.join(testDir, 'atomic.js');
    fs.writeFileSync(targetFile, '// original safe content', 'utf-8');

    {
      const { fsOps, openFds } = createFaultFs({
        writeSync: () => {
          throw makeErrno('ENOSPC', 'no space left on device');
        }
      });
      assert.throws(
        () => atomicWriteFile(targetFile, '// replacement content', fsOps),
        (err) => err.code === 'ENOSPC'
      );
      assert.strictEqual(openFds.size, 0, 'atomicWriteFile must close fd on writeSync ENOSPC');
      assert.strictEqual(fs.readFileSync(targetFile, 'utf-8'), '// original safe content');
      const leftovers = fs.readdirSync(testDir).filter(f => f.includes('-tmp-'));
      assert.deepStrictEqual(leftovers, [], 'atomicWriteFile must unlink partial temp file on ENOSPC');
    }
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Step 2 Temp-File ENOSPC Mid-Write: 3-file batch cleans all fds and temp siblings without mutating targets', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-step2-enospc-'));
  const taskId = `step2_enospc_${Date.now()}`;

  try {
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify Step 2 ENOSPC mid-write cleanup',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const base1 = '// mod1 base\n';
    const base2 = '// mod2 base\n';
    const base3 = '// mod3 base\n';
    fs.writeFileSync(path.join(testDir, 'src/mod1.js'), base1, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/mod2.js'), base2, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/mod3.js'), base3, 'utf-8');

    const d1 = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/mod1.js',
      originalContent: base1,
      stagedContent: '// mod1 staged\n',
      diffPatch: 'u1',
      projectPath: testDir
    });
    const d2 = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/mod2.js',
      originalContent: base2,
      stagedContent: '// mod2 staged\n',
      diffPatch: 'u2',
      projectPath: testDir
    });
    const d3 = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/mod3.js',
      originalContent: base3,
      stagedContent: '// mod3 staged\n',
      diffPatch: 'u3',
      projectPath: testDir
    });

    let writeCalls = 0;
    const { fsOps, openFds } = createFaultFs({
      writeSync: (realFs, fd, content, ...rest) => {
        writeCalls += 1;
        if (writeCalls === 2) {
          throw makeErrno('ENOSPC', 'disk full writing second temp file');
        }
        return realFs.writeSync(fd, content, ...rest);
      }
    });

    await assert.rejects(
      async () => {
        await KruschStateManager.applyDiffBatch(taskId, null, testDir, { fsOps });
      },
      (err) => {
        assert.strictEqual(err.code, 'ENOSPC');
        return true;
      }
    );

    // 1. Zero open fds leaked
    assert.strictEqual(openFds.size, 0, 'Zero file descriptors may leak when writeSync throws ENOSPC');

    // 2. Zero .krusch-tmp-* orphans on disk (both file 1 and file 2 temp files unlinked)
    const dirEntries = fs.readdirSync(path.join(testDir, 'src'));
    const tempOrphans = dirEntries.filter(f => f.includes('.krusch-') && f.includes('-tmp-'));
    assert.deepStrictEqual(tempOrphans, [], 'Zero temp sibling orphans may remain on disk');

    // 3. Zero target files modified
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/mod1.js'), 'utf-8'), base1);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/mod2.js'), 'utf-8'), base2);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/mod3.js'), 'utf-8'), base3);

    // 4. All diffs remain PENDING and no journal left in APPLYING
    const diffsCheck = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2, $3) ORDER BY id ASC`,
      [d1.id, d2.id, d3.id]
    );
    assert.strictEqual(diffsCheck.rows.every(r => r.status === 'PENDING'), true);

    const journalCheck = await query(`SELECT * FROM krusch_apply_journal WHERE task_id = $1`, [taskId]);
    assert.strictEqual(journalCheck.rows.length, 0);
  } finally {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Compound Fault #1: ENOSPC during in-process rollback keeps APPLYING, blocks COMMITTED, and heals via recoverInFlightApplies', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-compound-fault1-'));
  const taskId = `compound_fault1_${Date.now()}`;

  try {
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify compound rollback ENOSPC preserves APPLYING until recovery heals',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const baseA = 'export const a = "base_A";\n';
    const stagedA = 'export const a = "staged_A";\n';
    const stagedB = 'export const b = "staged_new_B";\n';

    fs.writeFileSync(path.join(testDir, 'src/fileA.js'), baseA, 'utf-8');

    const diffA = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileA.js',
      originalContent: baseA,
      stagedContent: stagedA,
      diffPatch: 'update fileA',
      projectPath: testDir
    });

    const diffB = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileB.js',
      originalContent: null,
      stagedContent: stagedB,
      diffPatch: 'create fileB',
      projectPath: testDir
    });

    // Fault injection:
    // - Step 2 temp writes succeed for both fileA and fileB
    // - Step 4 renameSync #1 (fileA) succeeds -> disk fileA becomes stagedA
    // - Step 4 renameSync #2 (fileB) throws ENOSPC
    // - Step 4 rollback atomicWriteFile on fileA ALSO throws ENOSPC on writeSync!
    let inRollback = false;
    const { fsOps, openFds } = createFaultFs({
      renameSync: (realFs, src, dest) => {
        if (dest.endsWith('fileB.js')) {
          inRollback = true;
          throw makeErrno('ENOSPC', 'no space left renaming fileB.js');
        }
        return realFs.renameSync(src, dest);
      },
      writeSync: (realFs, fd, content, ...rest) => {
        if (inRollback) {
          throw makeErrno('ENOSPC', 'no space left writing rollback preimage for fileA.js');
        }
        return realFs.writeSync(fd, content, ...rest);
      }
    });

    await assert.rejects(
      async () => {
        await KruschStateManager.applyDiffBatch(taskId, null, testDir, { fsOps });
      },
      (err) => {
        assert.strictEqual(err.code, 'COMPOUND_ROLLBACK_FAILED');
        assert.ok(err.message.includes('COMPOUND_ROLLBACK_FAILED'));
        assert.ok(Array.isArray(err.rollbackErrors));
        assert.strictEqual(err.rollbackErrors.length, 1);
        assert.strictEqual(err.rollbackErrors[0].filePath, 'src/fileA.js');
        assert.strictEqual(err.rollbackErrors[0].code, 'ENOSPC');
        return true;
      }
    );

    assert.strictEqual(openFds.size, 0, 'Zero fds leaked after compound rollback failure');

    // Disk is currently torn: fileA has stagedA, fileB does not exist
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), stagedA);
    assert.strictEqual(fs.existsSync(path.join(testDir, 'src/fileB.js')), false);

    // CRITICAL INVARIANT (INV-REC-02): PostgreSQL MUST keep diffs in APPLYING (NEVER falsely PENDING!)
    const midDiffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [diffA.id, diffB.id]
    );
    assert.strictEqual(midDiffs.rows[0].status, 'APPLYING');
    assert.strictEqual(midDiffs.rows[1].status, 'APPLYING');

    // Journal MUST stay APPLYING with error_message populated
    const midJournal = await query(
      `SELECT state, error_message, completed_at FROM krusch_apply_journal WHERE task_id = $1`,
      [taskId]
    );
    assert.strictEqual(midJournal.rows.length, 1);
    assert.strictEqual(midJournal.rows[0].state, 'APPLYING');
    assert.strictEqual(midJournal.rows[0].completed_at, null);
    assert.ok(midJournal.rows[0].error_message.includes('COMPOUND_ROLLBACK_FAILED'));

    // Event log recorded apply_rollback_failed
    const rbEvents = await query(
      `SELECT * FROM krusch_events WHERE task_id = $1 AND event_type = 'apply_rollback_failed'`,
      [taskId]
    );
    assert.strictEqual(rbEvents.rows.length, 1);

    // PostgreSQL trigger MUST block APPROVAL_GATE -> COMMITTED while APPLYING rows exist!
    await assert.rejects(
      async () => {
        await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
      },
      (err) => {
        assert.ok(err.message.includes('Invariant Violation'));
        return true;
      }
    );

    // Now disk space recovers: run recoverInFlightApplies with healthy fs
    const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
    assert.strictEqual(recovered.length, 2);
    assert.strictEqual(recovered.every(r => r.outcome === 'BATCH_ROLLBACK_REVERTED_TO_PENDING'), true);

    // Verify fileA rolled back byte-for-byte to baseA, diffs are PENDING, journal is ROLLED_BACK
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), baseA);
    assert.strictEqual(fs.existsSync(path.join(testDir, 'src/fileB.js')), false);

    const healedDiffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [diffA.id, diffB.id]
    );
    assert.strictEqual(healedDiffs.rows[0].status, 'PENDING');
    assert.strictEqual(healedDiffs.rows[1].status, 'PENDING');

    const healedJournal = await query(
      `SELECT state, error_message, completed_at FROM krusch_apply_journal WHERE task_id = $1`,
      [taskId]
    );
    assert.strictEqual(healedJournal.rows[0].state, 'ROLLED_BACK');
    assert.ok(healedJournal.rows[0].completed_at);

    // Subsequent applyDiffBatch now cleanly applies both files!
    const applyRes = await KruschStateManager.applyDiffBatch(taskId, null, testDir);
    assert.strictEqual(applyRes.status, 'APPLIED');
    assert.strictEqual(applyRes.appliedCount, 2);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), stagedA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), stagedB);

    await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id = $2 AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, taskId]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Compound Fault #2: ENOSPC mid-recoverInFlightApplies defers DB transition across 3-file partial crash until Recovery #2', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-compound-fault2-'));
  const taskId = `compound_fault2_${Date.now()}`;

  try {
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify mid-recovery ENOSPC across 3-file partial crash',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const baseA = '// base A\n';
    const baseB = '// base B\n';
    const baseC = '// base C\n';
    const stagedA = '// staged A\n';
    const stagedB = '// staged B\n';
    const stagedC = '// staged C\n';

    fs.writeFileSync(path.join(testDir, 'src/fileA.js'), baseA, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/fileB.js'), baseB, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/fileC.js'), baseC, 'utf-8');

    const diffA = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileA.js',
      originalContent: baseA,
      stagedContent: stagedA,
      diffPatch: 'A',
      projectPath: testDir
    });
    const diffB = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileB.js',
      originalContent: baseB,
      stagedContent: stagedB,
      diffPatch: 'B',
      projectPath: testDir
    });
    const diffC = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileC.js',
      originalContent: baseC,
      stagedContent: stagedC,
      diffPatch: 'C',
      projectPath: testDir
    });

    // Simulate Crash #1: fileA & fileB were renamed (stagedA, stagedB), fileC untouched (baseC), all 3 APPLYING
    await query(
      `INSERT INTO krusch_apply_journal (task_id, project_path, state, files, created_at)
       VALUES ($1, $2, 'APPLYING', $3, NOW())`,
      [taskId, testDir, JSON.stringify([{ diffId: diffA.id }, { diffId: diffB.id }, { diffId: diffC.id }])]
    );
    await query(
      `UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2, $3)`,
      [diffA.id, diffB.id, diffC.id]
    );
    fs.writeFileSync(path.join(testDir, 'src/fileA.js'), stagedA, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/fileB.js'), stagedB, 'utf-8');

    // Recovery #1: fileA rolls back to baseA, then rolling back fileB hits ENOSPC!
    let atomicTempOpens = 0;
    const { fsOps, openFds } = createFaultFs({
      writeSync: (realFs, fd, content, ...rest) => {
        atomicTempOpens += 1;
        if (atomicTempOpens === 2) {
          throw makeErrno('ENOSPC', 'disk full while rolling back fileB.js');
        }
        return realFs.writeSync(fd, content, ...rest);
      }
    });

    const rec1 = await KruschStateManager.recoverInFlightApplies(testDir, { fsOps });
    assert.strictEqual(rec1.length, 1);
    assert.strictEqual(rec1[0].taskId, taskId);
    assert.strictEqual(rec1[0].outcome, 'RECOVERY_DEFERRED_IO_ERROR');
    assert.ok(rec1[0].error.includes('ENOSPC'));
    assert.strictEqual(openFds.size, 0, 'Zero fds leaked during failed mid-recovery rollback');

    // Also verify strict: true rethrows when requested
    const { fsOps: strictFailFs } = createFaultFs({
      writeSync: () => {
        throw makeErrno('EIO', 'disk I/O failure on strict recovery');
      }
    });
    await assert.rejects(
      async () => {
        await KruschStateManager.recoverInFlightApplies(testDir, { fsOps: strictFailFs, strict: true });
      },
      (err) => err.code === 'EIO'
    );

    // Check intermediate state:
    // - fileA was rolled back to baseA, fileB is STILL stagedB, fileC is baseC
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), baseA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), stagedB);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileC.js'), 'utf-8'), baseC);

    // - ALL 3 rows in PostgreSQL MUST remain APPLYING!
    const midDiffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2, $3) ORDER BY id ASC`,
      [diffA.id, diffB.id, diffC.id]
    );
    assert.strictEqual(midDiffs.rows.every(r => r.status === 'APPLYING'), true);

    const midJournal = await query(
      `SELECT state, error_message FROM krusch_apply_journal WHERE task_id = $1`,
      [taskId]
    );
    assert.strictEqual(midJournal.rows[0].state, 'APPLYING');
    assert.ok(midJournal.rows[0].error_message.includes('COMPOUND_RECOVERY_IO_ERROR'));

    // Recovery #2 (healthy fs): sees fileA untouched, fileB renamed, fileC untouched -> rolls back fileB and commits PENDING
    const rec2 = await KruschStateManager.recoverInFlightApplies(testDir);
    assert.strictEqual(rec2.length, 3);
    assert.strictEqual(rec2.every(r => r.outcome === 'BATCH_ROLLBACK_REVERTED_TO_PENDING'), true);

    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), baseA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), baseB);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileC.js'), 'utf-8'), baseC);

    const finalDiffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2, $3) ORDER BY id ASC`,
      [diffA.id, diffB.id, diffC.id]
    );
    assert.strictEqual(finalDiffs.rows.every(r => r.status === 'PENDING'), true);

    const finalJournal = await query(
      `SELECT state, error_message, completed_at FROM krusch_apply_journal WHERE task_id = $1`,
      [taskId]
    );
    assert.strictEqual(finalJournal.rows[0].state, 'ROLLED_BACK');
    assert.strictEqual(finalJournal.rows[0].error_message, null);
    assert.ok(finalJournal.rows[0].completed_at);
  } finally {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Compound Fault #3: PostgreSQL Step 5 commit failure + mid-recovery OOM rollback never tears APPLIED/APPLYING state', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-compound-fault3-'));
  const taskId = `compound_fault3_${Date.now()}`;

  try {
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify PostgreSQL transaction atomicity on Step 5 and recovery OOM',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const baseA = '// pg fault base A\n';
    const baseB = '// pg fault base B\n';
    const stagedA = '// pg fault staged A\n';
    const stagedB = '// pg fault staged B\n';
    fs.writeFileSync(path.join(testDir, 'src/fileA.js'), baseA, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/fileB.js'), baseB, 'utf-8');

    const diffA = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileA.js',
      originalContent: baseA,
      stagedContent: stagedA,
      diffPatch: 'A',
      projectPath: testDir
    });
    const diffB = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileB.js',
      originalContent: baseB,
      stagedContent: stagedB,
      diffPatch: 'B',
      projectPath: testDir
    });

    // 1. Inject PostgreSQL OOM/connection failure on Step 5 AFTER all disk renames completed
    const step5FailTx = async (callback) => {
      return await withTransaction(async (client) => {
        let updateCount = 0;
        const wrappedClient = {
          ...client,
          query: async (sql, params) => {
            const res = await client.query(sql, params);
            updateCount += 1;
            if (updateCount === 1) {
              // Simulate PG OOM right after krusch_staged_diffs UPDATE but before krusch_apply_journal UPDATE!
              const pgErr = new Error('out of shared memory (SQLSTATE 53200)');
              pgErr.code = '53200';
              throw pgErr;
            }
            return res;
          }
        };
        return await callback(wrappedClient);
      });
    };

    await assert.rejects(
      async () => {
        await KruschStateManager.applyDiffBatch(taskId, null, testDir, { withTransactionFn: step5FailTx });
      },
      (err) => err.code === '53200'
    );

    // Physical disk holds stagedA & stagedB, while PG rolled back Step 5 atomically so BOTH diffs & journal stay APPLYING!
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileA.js'), 'utf-8'), stagedA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), stagedB);

    const afterStep5Diffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [diffA.id, diffB.id]
    );
    assert.strictEqual(afterStep5Diffs.rows[0].status, 'APPLYING');
    assert.strictEqual(afterStep5Diffs.rows[1].status, 'APPLYING');

    const afterStep5Journal = await query(
      `SELECT state FROM krusch_apply_journal WHERE task_id = $1`,
      [taskId]
    );
    assert.strictEqual(afterStep5Journal.rows[0].state, 'APPLYING');

    // 2. Recovery #1: Inject PostgreSQL OOM mid-transaction AFTER updating diffA to APPLIED, BEFORE updating diffB!
    const recoveryMidBatchOomTx = async (callback) => {
      return await withTransaction(async (client) => {
        let appliedDiffUpdates = 0;
        const wrappedClient = {
          ...client,
          query: async (sql, params) => {
            if (sql.includes("SET status = 'APPLIED'")) {
              appliedDiffUpdates += 1;
              if (appliedDiffUpdates === 2) {
                const oomErr = new Error('out of memory during recovery batch commit');
                oomErr.code = '53200';
                throw oomErr;
              }
            }
            return await client.query(sql, params);
          }
        };
        return await callback(wrappedClient);
      });
    };

    await assert.rejects(
      async () => {
        await KruschStateManager.recoverInFlightApplies(testDir, { withTransactionFn: recoveryMidBatchOomTx });
      },
      (err) => err.code === '53200'
    );

    // Verify atomic PG rollback: diffA MUST NOT be APPLIED while diffB is APPLYING — BOTH remain APPLYING!
    const afterRec1Diffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [diffA.id, diffB.id]
    );
    assert.strictEqual(afterRec1Diffs.rows[0].status, 'APPLYING');
    assert.strictEqual(afterRec1Diffs.rows[1].status, 'APPLYING');

    // 3. Recovery #2 with healthy PostgreSQL promotes both rows AND journal to APPLIED atomically!
    const rec2 = await KruschStateManager.recoverInFlightApplies(testDir);
    assert.strictEqual(rec2.length, 2);
    assert.strictEqual(rec2[0].outcome, 'APPLIED');
    assert.strictEqual(rec2[1].outcome, 'APPLIED');

    const finalDiffs = await query(
      `SELECT id, status, applied_at FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [diffA.id, diffB.id]
    );
    assert.strictEqual(finalDiffs.rows[0].status, 'APPLIED');
    assert.strictEqual(finalDiffs.rows[1].status, 'APPLIED');
    assert.ok(finalDiffs.rows[0].applied_at);
    assert.ok(finalDiffs.rows[1].applied_at);

    const finalJournal = await query(
      `SELECT state, completed_at FROM krusch_apply_journal WHERE task_id = $1`,
      [taskId]
    );
    assert.strictEqual(finalJournal.rows[0].state, 'APPLIED');
    assert.ok(finalJournal.rows[0].completed_at);

    await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id = $2 AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, taskId]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Compound Fault #4 (INV-REC-02): Non-swallowed unlinkSync EACCES on newly-created file prevents WORKING_TREE_DRIFT_DETECTED bricking', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-unlink-eacces-'));
  const taskId = `unlink_eacces_${Date.now()}`;

  try {
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify unlinkSync EACCES on brand-new file rollback is never swallowed',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const stagedNew = 'export const created = true;\n';
    const baseB = 'export const b = 1;\n';
    const stagedB = 'export const b = 2;\n';
    fs.writeFileSync(path.join(testDir, 'src/fileB.js'), baseB, 'utf-8');

    const diffNew = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/newFile.js',
      originalContent: null,
      stagedContent: stagedNew,
      diffPatch: 'add newFile.js',
      projectPath: testDir
    });
    assert.strictEqual(diffNew.original_sha256, null);

    const diffB = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/fileB.js',
      originalContent: baseB,
      stagedContent: stagedB,
      diffPatch: 'update fileB.js',
      projectPath: testDir
    });

    // Simulate Crash #1: newFile.js was renamed onto disk, crashed before fileB.js
    await query(
      `INSERT INTO krusch_apply_journal (task_id, project_path, state, files, created_at)
       VALUES ($1, $2, 'APPLYING', $3, NOW())`,
      [taskId, testDir, JSON.stringify([{ diffId: diffNew.id }, { diffId: diffB.id }])]
    );
    await query(
      `UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2)`,
      [diffNew.id, diffB.id]
    );
    const newFilePath = path.join(testDir, 'src/newFile.js');
    fs.writeFileSync(newFilePath, stagedNew, 'utf-8');

    // Recovery #1: Inject EACCES on unlinkSync(newFile.js)
    const { fsOps } = createFaultFs({
      unlinkSync: (realFs, targetPath) => {
        if (targetPath.endsWith('newFile.js')) {
          throw makeErrno('EACCES', 'permission denied unlinking newFile.js');
        }
        return realFs.unlinkSync(targetPath);
      }
    });

    const rec1 = await KruschStateManager.recoverInFlightApplies(testDir, { fsOps });
    assert.strictEqual(rec1.length, 1);
    assert.strictEqual(rec1[0].outcome, 'RECOVERY_DEFERRED_IO_ERROR');
    assert.ok(rec1[0].error.includes('EACCES'));

    // newFile.js is still on disk AND diffs MUST still be APPLYING (not PENDING!)
    assert.strictEqual(fs.existsSync(newFilePath), true);
    const midDiffs = await query(
      `SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [diffNew.id, diffB.id]
    );
    assert.strictEqual(midDiffs.rows[0].status, 'APPLYING');
    assert.strictEqual(midDiffs.rows[1].status, 'APPLYING');

    // Recovery #2 (EACCES cleared): unlinks newFile.js and reverts batch to PENDING
    const rec2 = await KruschStateManager.recoverInFlightApplies(testDir);
    assert.strictEqual(rec2.length, 2);
    assert.strictEqual(rec2.every(r => r.outcome === 'BATCH_ROLLBACK_REVERTED_TO_PENDING'), true);
    assert.strictEqual(fs.existsSync(newFilePath), false);

    // Subsequent applyDiffBatch succeeds without WORKING_TREE_DRIFT_DETECTED!
    const applyRes = await KruschStateManager.applyDiffBatch(taskId, null, testDir);
    assert.strictEqual(applyRes.status, 'APPLIED');
    assert.strictEqual(applyRes.appliedCount, 2);
    assert.strictEqual(fs.readFileSync(newFilePath, 'utf-8'), stagedNew);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/fileB.js'), 'utf-8'), stagedB);

    await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id = $2 AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, taskId]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Pre-Flight Auto-Reconciliation & Preimage Integrity: applyDiffBatch reconciles residual APPLYING state and CORRUPT_BASE_PREIMAGE aborts before disk mutation', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-preflight-preimage-'));
  const task1 = `preflight_reconcile_${Date.now()}`;
  const task2 = `corrupt_preimage_${Date.now()}`;

  try {
    // Part A: Calling applyDiffBatch directly when residual APPLYING rows exist reconciles and applies cleanly
    await KruschStateManager.createTask({
      id: task1,
      goal: 'Verify pre-flight applyDiffBatch reconciliation',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });
    await KruschStateManager.recordVerificationRun(task1, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'pkg1'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'pkg1/a.js'), '// a0\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'pkg1/b.js'), '// b0\n', 'utf-8');

    const d1 = await KruschStateManager.stageDiff(task1, {
      filePath: 'pkg1/a.js',
      originalContent: '// a0\n',
      stagedContent: '// a1\n',
      diffPatch: 'a',
      projectPath: testDir
    });
    const d2 = await KruschStateManager.stageDiff(task1, {
      filePath: 'pkg1/b.js',
      originalContent: '// b0\n',
      stagedContent: '// b1\n',
      diffPatch: 'b',
      projectPath: testDir
    });

    // Leave torn APPLYING state (a.js renamed, b.js untouched)
    await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2)`, [d1.id, d2.id]);
    fs.writeFileSync(path.join(testDir, 'pkg1/a.js'), '// a1\n', 'utf-8');

    // Direct applyDiffBatch call reconciles torn state first, then applies both files
    const directRes = await KruschStateManager.applyDiffBatch(task1, null, testDir);
    assert.strictEqual(directRes.status, 'APPLIED');
    assert.strictEqual(directRes.appliedCount, 2);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'pkg1/a.js'), 'utf-8'), '// a1\n');
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'pkg1/b.js'), 'utf-8'), '// b1\n');
    await KruschStateManager.updateTask(task1, { phase: HARNESS_PHASES.COMMITTED });

    // Part B: CORRUPT_BASE_PREIMAGE on 2nd file throws BEFORE mutating 1st file on disk
    await KruschStateManager.createTask({
      id: task2,
      goal: 'Verify CORRUPT_BASE_PREIMAGE pre-validation before disk rollback',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });
    await KruschStateManager.recordVerificationRun(task2, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'pkg2'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'pkg2/f1.js'), '// f1_base\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'pkg2/f2.js'), '// f2_base\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'pkg2/f3.js'), '// f3_base\n', 'utf-8');

    const c1 = await KruschStateManager.stageDiff(task2, {
      filePath: 'pkg2/f1.js',
      originalContent: '// f1_base\n',
      stagedContent: '// f1_staged\n',
      diffPatch: '1',
      projectPath: testDir
    });
    const c2 = await KruschStateManager.stageDiff(task2, {
      filePath: 'pkg2/f2.js',
      originalContent: '// f2_base\n',
      stagedContent: '// f2_staged\n',
      diffPatch: '2',
      projectPath: testDir
    });
    const c3 = await KruschStateManager.stageDiff(task2, {
      filePath: 'pkg2/f3.js',
      originalContent: '// f3_base\n',
      stagedContent: '// f3_staged\n',
      diffPatch: '3',
      projectPath: testDir
    });

    await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2, $3)`, [c1.id, c2.id, c3.id]);
    fs.writeFileSync(path.join(testDir, 'pkg2/f1.js'), '// f1_staged\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'pkg2/f2.js'), '// f2_staged\n', 'utf-8');
    // Corrupt stored original_content on c2 while keeping original_sha256
    await query(`UPDATE krusch_staged_diffs SET original_content = '// corrupted_preimage!' WHERE id = $1`, [c2.id]);

    await assert.rejects(
      async () => {
        await KruschStateManager.recoverInFlightApplies(testDir);
      },
      (err) => err.message.includes('CORRUPT_BASE_PREIMAGE')
    );

    // f1.js was NOT rolled back because preimage hashes for the whole batch were validated BEFORE mutating disk!
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'pkg2/f1.js'), 'utf-8'), '// f1_staged\n');
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id IN ($2, $3) AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, task1, task2]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Short-Write Loop & Recovery Inspection EACCES: writeAllSync loops across partial POSIX writes, rejects 0-byte short writes, and defers recovery on transient readFileSync EACCES', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-shortwrite-inspect-'));
  const taskId = `shortwrite_inspect_${Date.now()}`;

  try {
    // Part A: atomicWriteFile loops across 5-byte partial writeSync chunks and rejects 0-byte short writes
    let writeChunks = 0;
    const { fsOps: chunkedFs, openFds: chunkFds } = createFaultFs({
      writeSync: (realFs, fd, buffer, offset = 0, length = buffer.length) => {
        writeChunks += 1;
        const sliceLen = Math.min(5, length);
        return realFs.writeSync(fd, buffer, offset, sliceLen);
      }
    });
    const targetFile = path.join(testDir, 'chunked.txt');
    const expectedPayload = '0123456789abcdefghijKLMNOPQRST';
    atomicWriteFile(targetFile, expectedPayload, chunkedFs);
    assert.ok(writeChunks >= 6, `Expected multi-chunk write loop, got ${writeChunks}`);
    assert.strictEqual(fs.readFileSync(targetFile, 'utf-8'), expectedPayload);
    assert.strictEqual(chunkFds.size, 0);

    const { fsOps: zeroWriteFs, openFds: zeroFds } = createFaultFs({
      writeSync: () => 0
    });
    assert.throws(
      () => atomicWriteFile(targetFile, 'should-not-truncate', zeroWriteFs),
      (err) => err.code === 'EIO'
    );
    assert.strictEqual(fs.readFileSync(targetFile, 'utf-8'), expectedPayload);
    assert.strictEqual(zeroFds.size, 0);

    // Part B: Transient EACCES during recoverInFlightApplies inspection defers recovery instead of false DRIFT_REJECTED
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify transient readFileSync EACCES during recovery inspection defers to RECOVERY_DEFERRED_IO_ERROR',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'inspect'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'inspect/one.js'), '// one base\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'inspect/two.js'), '// two base\n', 'utf-8');

    const dOne = await KruschStateManager.stageDiff(taskId, {
      filePath: 'inspect/one.js',
      originalContent: '// one base\n',
      stagedContent: '// one staged\n',
      diffPatch: '1',
      projectPath: testDir
    });
    const dTwo = await KruschStateManager.stageDiff(taskId, {
      filePath: 'inspect/two.js',
      originalContent: '// two base\n',
      stagedContent: '// two staged\n',
      diffPatch: '2',
      projectPath: testDir
    });

    await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2)`, [dOne.id, dTwo.id]);
    fs.writeFileSync(path.join(testDir, 'inspect/one.js'), '// one staged\n', 'utf-8');

    const { fsOps: inspectFailFs } = createFaultFs({
      readFileSync: (realFs, p, enc) => {
        if (String(p).endsWith('two.js')) {
          throw makeErrno('EACCES', 'transient directory EACCES during crash recovery inspection');
        }
        return realFs.readFileSync(p, enc);
      }
    });

    const recDeferred = await KruschStateManager.recoverInFlightApplies(testDir, { fsOps: inspectFailFs });
    assert.strictEqual(recDeferred.length, 1);
    assert.strictEqual(recDeferred[0].outcome, 'RECOVERY_DEFERRED_IO_ERROR');

    // Crucially, neither diff was falsely marked REJECTED!
    const checkStatuses = await query(
      `SELECT status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC`,
      [dOne.id, dTwo.id]
    );
    assert.strictEqual(checkStatuses.rows.every((r) => r.status === 'APPLYING'), true);

    // Once EACCES clears, recovery rolls back one.js to base and reverts both to PENDING
    const recClean = await KruschStateManager.recoverInFlightApplies(testDir);
    assert.strictEqual(recClean.length, 2);
    assert.strictEqual(recClean.every((r) => r.outcome === 'BATCH_ROLLBACK_REVERTED_TO_PENDING'), true);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'inspect/one.js'), 'utf-8'), '// one base\n');
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id = $2 AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, taskId]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await pool.end();
});
