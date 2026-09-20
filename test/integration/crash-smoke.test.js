import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { query, pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('Real Crash Smoke: kill -9 mid-apply on multi-file batch, reboot recovery, assert disk and DB', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-smoke-crash-'));
  const taskId = `smoke_crash_${Date.now()}`;

  // 1. Initialize Task in PostgreSQL
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Smoke test kill -9 recovery on multi-file batch',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  // 2. Setup ground-truth files on physical disk
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  const baseA = '// Module A (Original Base Content)\nexport function getA() { return "A"; }\n';
  const baseB = '// Module B (Original Base Content)\nexport function getB() { return "B"; }\n';
  fs.writeFileSync(path.join(testDir, 'src/moduleA.js'), baseA, 'utf-8');
  fs.writeFileSync(path.join(testDir, 'src/moduleB.js'), baseB, 'utf-8');

  // 3. Stage multi-file diffs into PostgreSQL
  const stagedA = '// Module A (Updated Staged Content)\nexport function getA() { return "A_UPDATED"; }\n';
  const stagedB = '// Module B (Updated Staged Content)\nexport function getB() { return "B_UPDATED"; }\n';

  const diffA = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/moduleA.js',
    originalContent: baseA,
    stagedContent: stagedA,
    diffPatch: 'update moduleA',
    projectPath: testDir
  });

  const diffB = await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/moduleB.js',
    originalContent: baseB,
    stagedContent: stagedB,
    diffPatch: 'update moduleB',
    projectPath: testDir
  });

  // 4. Record passing verification run to satisfy APPROVAL_GATE requirements
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'npm run test:unit',
    exitCode: 0,
    stdout: '2 suites passed',
    stderr: '',
    passed: true
  });

  // 5. Spawn a worker child process to perform the apply via real KruschStateManager.applyDiffBatch,
  // driven by an explicit deterministic sync point (test hook after first rename) and terminated via SIGKILL (kill -9).
  const markerFile = path.join(testDir, '.crash-marker');
  const workerScript = `
    import { KruschStateManager } from '${path.resolve('src/brain/state-manager.js')}';

    async function runWorker() {
      await KruschStateManager.applyDiffBatch('${taskId}', [${diffA.id}, ${diffB.id}], '${testDir}');
    }

    runWorker().catch(err => {
      console.error(err);
      process.exit(1);
    });
  `;

  const workerFile = path.join(testDir, 'worker.mjs');
  fs.writeFileSync(workerFile, workerScript, 'utf-8');

  const child = fork(workerFile, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME: '1',
      KRUSCH_TEST_HOOK_MARKER_FILE: markerFile
    }
  });

  await new Promise((resolve, reject) => {
    child.on('message', (msg) => {
      if (msg.readyForKill) {
        // Send SIGKILL (kill -9) to simulate violent crash mid-batch immediately after first file rename
        child.kill('SIGKILL');
      }
    });

    child.on('exit', (code, signal) => {
      try {
        assert.strictEqual(signal, 'SIGKILL');
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    child.on('error', reject);
  });

  // 6. Assert Inconsistent Mid-Crash State
  // DB status is APPLYING
  const checkApplying = await query('SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2)', [diffA.id, diffB.id]);
  assert.strictEqual(checkApplying.rows[0].status, 'APPLYING');
  assert.strictEqual(checkApplying.rows[1].status, 'APPLYING');

  // Physical disk is inconsistent (moduleA renamed to stagedA, moduleB still baseB, temp file exists for moduleB)
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleA.js'), 'utf-8'), stagedA);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleB.js'), 'utf-8'), baseB);
  const midDirFiles = fs.readdirSync(path.join(testDir, 'src'));
  const tempFileB = midDirFiles.find(f => f.startsWith('.moduleB.js.krusch-tmp-'));
  assert.ok(tempFileB, 'Sibling temp file for moduleB should exist mid-crash');

  // 7. Start Up Again: Run Krusch Startup Recovery Protocol
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  const pruned = await KruschStateManager.pruneExpiredLeases();

  assert.strictEqual(recovered.length, 2);
  assert.strictEqual(recovered[0].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');
  assert.strictEqual(recovered[1].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');

  // 8. Assert Complete Post-Recovery Consistency:
  // (a) DB: Both diff rows reverted to PENDING
  const checkPost = await query('SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2)', [diffA.id, diffB.id]);
  assert.strictEqual(checkPost.rows[0].status, 'PENDING');
  assert.strictEqual(checkPost.rows[1].status, 'PENDING');

  // (b) Disk: moduleA rolled back to baseA! moduleB is at baseB!
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleA.js'), 'utf-8'), baseA);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleB.js'), 'utf-8'), baseB);

  // (c) Orphaned temp file unlinked
  const postDirFiles = fs.readdirSync(path.join(testDir, 'src'));
  const postTempFileB = postDirFiles.find(f => f.startsWith('.moduleB.js.krusch-tmp-'));
  assert.strictEqual(postTempFileB, undefined, 'Orphaned temp file should be unlinked on recovery');

  // (d) Audit event recorded in PostgreSQL
  const eventRes = await query(
    `SELECT event_type, payload FROM krusch_events WHERE task_id = $1 AND event_type = 'recovery_performed'`,
    [taskId]
  );
  assert.strictEqual(eventRes.rows.length >= 2, true);

  // (e) Explain diagnostic reports consistent next transitions
  const exp = await KruschStateManager.explainTaskStatus(taskId);
  assert.strictEqual(exp.phase, 'APPROVAL_GATE');
  assert.strictEqual(exp.diffSummary.pending, 2);
  assert.strictEqual(exp.diffSummary.applying, 0);

  // Clean up
  await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
