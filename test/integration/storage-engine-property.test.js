import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { query, pool } from '../../src/brain/pool.js';
import { KruschStateManager, canonicalizePaths } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('Storage Engine Property: Content-Addressed Blob Storage deduplicates identical contents', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-blob-test-'));
  const taskId = `blob_task_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test blob deduplication',
    projectPath: testDir,
    phase: HARNESS_PHASES.IMPLEMENT
  });

  const sharedContent = 'export function sharedHelper() { return "deduplicated"; }\n';
  const expectedHash = crypto.createHash('sha256').update(sharedContent).digest('hex');

  // Stage diff on file 1
  await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/moduleA.js',
    originalContent: null,
    stagedContent: sharedContent,
    diffPatch: 'add',
    projectPath: testDir
  });

  // Stage diff on file 2 with identical content
  await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/moduleB.js',
    originalContent: null,
    stagedContent: sharedContent,
    diffPatch: 'add',
    projectPath: testDir
  });

  // Verify that only 1 blob row exists in krusch_blobs for this hash
  const blobRes = await query('SELECT * FROM krusch_blobs WHERE sha256 = $1', [expectedHash]);
  assert.strictEqual(blobRes.rows.length, 1);
  assert.strictEqual(blobRes.rows[0].byte_size, Buffer.byteLength(sharedContent, 'utf-8'));

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Storage Engine Property: Pre-commit drift check mid-batch aborts without touching any disk file', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-drift-batch-test-'));
  const taskId = `drift_batch_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test drift prevention',
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

  // Create base disk files
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'src/clean.js'), 'const a = 1;\n', 'utf-8');
  fs.writeFileSync(path.join(testDir, 'src/drifted.js'), 'const b = 1;\n', 'utf-8');

  // Stage modifications
  await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/clean.js',
    originalContent: 'const a = 1;\n',
    stagedContent: 'const a = 2;\n',
    diffPatch: 'patch1',
    projectPath: testDir
  });

  await KruschStateManager.stageDiff(taskId, {
    filePath: 'src/drifted.js',
    originalContent: 'const b = 1;\n',
    stagedContent: 'const b = 2;\n',
    diffPatch: 'patch2',
    projectPath: testDir
  });

  // Out-of-band disk modification on drifted.js
  fs.writeFileSync(path.join(testDir, 'src/drifted.js'), 'const b = 999; // drift!\n', 'utf-8');

  // Attempt applyBatch
  await assert.rejects(
    async () => {
      await KruschStateManager.applyDiffBatch(taskId, null, testDir);
    },
    (err) => {
      assert.strictEqual(err.code, 'WORKING_TREE_DRIFT_DETECTED');
      return true;
    }
  );

  // Assert neither file was modified by the aborted batch
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/clean.js'), 'utf-8'), 'const a = 1;\n');
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/drifted.js'), 'utf-8'), 'const b = 999; // drift!\n');

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Storage Engine Property: Partial batch apply crash recovery atomically rolls back renamed files', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-partial-rollback-test-'));
  const taskId = `partial_rollback_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test partial batch rollback',
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

  const baseContent1 = '// base content 1\n';
  const stagedContent1 = '// staged content 1 (renamed before crash)\n';
  const baseContent2 = '// base content 2\n';
  const stagedContent2 = '// staged content 2 (unrenamed at crash)\n';

  fs.mkdirSync(path.join(testDir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'pkg/f1.js'), baseContent1, 'utf-8');
  fs.writeFileSync(path.join(testDir, 'pkg/f2.js'), baseContent2, 'utf-8');

  const diff1 = await KruschStateManager.stageDiff(taskId, {
    filePath: 'pkg/f1.js',
    originalContent: baseContent1,
    stagedContent: stagedContent1,
    diffPatch: 'diff1',
    projectPath: testDir
  });

  const diff2 = await KruschStateManager.stageDiff(taskId, {
    filePath: 'pkg/f2.js',
    originalContent: baseContent2,
    stagedContent: stagedContent2,
    diffPatch: 'diff2',
    projectPath: testDir
  });

  // Simulate mid-crash state:
  // - Both diffs are in APPLYING in DB
  // - f1.js was renamed to stagedContent1
  // - f2.js was untouched (still baseContent2)
  // - temp files exist for both
  await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id IN ($1, $2)`, [diff1.id, diff2.id]);
  fs.writeFileSync(path.join(testDir, 'pkg/f1.js'), stagedContent1, 'utf-8');
  fs.writeFileSync(path.join(testDir, 'pkg/.f1.js.krusch-tmp-999-aaa'), '// temp1', 'utf-8');
  fs.writeFileSync(path.join(testDir, 'pkg/.f2.js.krusch-tmp-999-bbb'), '// temp2', 'utf-8');

  // Run startup crash recovery
  const recovered = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.strictEqual(recovered.length, 2);
  assert.strictEqual(recovered[0].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');
  assert.strictEqual(recovered[1].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');

  // Assert both files on disk were reverted to base preimages
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'pkg/f1.js'), 'utf-8'), baseContent1);
  assert.strictEqual(fs.readFileSync(path.join(testDir, 'pkg/f2.js'), 'utf-8'), baseContent2);

  // Assert orphaned temp files were cleaned up
  assert.strictEqual(fs.existsSync(path.join(testDir, 'pkg/.f1.js.krusch-tmp-999-aaa')), false);
  assert.strictEqual(fs.existsSync(path.join(testDir, 'pkg/.f2.js.krusch-tmp-999-bbb')), false);

  // Assert both diff rows in DB reverted to PENDING
  const dbRows = await query(`SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2)`, [diff1.id, diff2.id]);
  assert.strictEqual(dbRows.rows.every(r => r.status === 'PENDING'), true);

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Storage Engine Property: Idempotent crash recovery produces zero side effects on replay', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-idempotent-recovery-'));
  const taskId = `idempotent_${Date.now()}`;

  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Test recovery idempotency',
    projectPath: testDir,
    phase: HARNESS_PHASES.APPROVAL_GATE
  });

  // Run recovery when no APPLYING diffs exist
  const firstPass = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.deepStrictEqual(firstPass, []);

  const secondPass = await KruschStateManager.recoverInFlightApplies(testDir);
  assert.deepStrictEqual(secondPass, []);

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Storage Engine Property: Path canonicalization guarantees lease consistency', () => {
  const root = '/tmp/repo';
  const p1 = canonicalizePaths(root, './src/calculator.js');
  const p2 = canonicalizePaths(root, 'src/calculator.js');
  const p3 = canonicalizePaths(root, 'src/../src/calculator.js');

  assert.strictEqual(p1.filePath, 'src/calculator.js');
  assert.strictEqual(p2.filePath, 'src/calculator.js');
  assert.strictEqual(p3.filePath, 'src/calculator.js');

  // Directory traversal outside root must be rejected
  assert.throws(() => {
    canonicalizePaths(root, '../../etc/passwd');
  }, /traverses outside project root/);
});

test.after(async () => {
  await pool.end();
});
