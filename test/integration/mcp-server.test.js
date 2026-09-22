import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { KruschStateMachine } from '../../src/workflow/state-machine.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';
import { pool } from '../../src/brain/pool.js';

test('Integration: MCP Harness lifecycle end-to-end', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-mcp-test-'));
  const testFile = path.join(testDir, 'index.js');
  fs.writeFileSync(testFile, 'export function greet() { return "hello"; }\n', 'utf-8');

  const taskId = `task_mcp_${Date.now()}`;

  // 1. Initialize Task synchronously as krusch_run does
  await KruschStateManager.createTask({
    id: taskId,
    goal: 'Update greet function in index.js',
    projectPath: testDir,
    phase: HARNESS_PHASES.INIT
  });

  const taskBefore = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskBefore.id, taskId);
  assert.strictEqual(taskBefore.phase, HARNESS_PHASES.INIT);

  // 2. Stage a diff as a model would during IMPLEMENT
  const staged = await KruschStateManager.stageDiff(taskId, {
    filePath: 'index.js',
    projectPath: testDir,
    originalContent: 'export function greet() { return "hello"; }\n',
    stagedContent: 'export function greet() { return "hello world"; }\n',
    diffPatch: 'Update return value'
  });
  assert.strictEqual(staged.file_path, 'index.js');
  assert.strictEqual(staged.status, 'PENDING');

  // 3. Record verification run passing
  await KruschStateManager.recordVerificationRun(taskId, {
    command: 'node -e "process.exit(0)"',
    exitCode: 0,
    passed: true,
    stdout: 'Tests passed',
    stderr: ''
  });

  // Transition through legal FSM phases
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.PLAN });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.IMPLEMENT });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.VERIFY });
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.APPROVAL_GATE });

  // 4. Test explain
  const explanation = await KruschStateManager.explainTaskStatus(taskId);
  assert.ok(explanation);
  assert.strictEqual(explanation.taskId, taskId);
  assert.strictEqual(explanation.phase, HARNESS_PHASES.APPROVAL_GATE);

  // 5. Test applyDiffBatch as krusch_apply_diff does
  const applyRes = await KruschStateManager.applyDiffBatch(taskId, null, testDir);
  assert.strictEqual(applyRes.status, 'APPLIED');
  assert.strictEqual(applyRes.appliedCount, 1);

  // Verify disk mutation
  const diskContent = fs.readFileSync(testFile, 'utf-8');
  assert.strictEqual(diskContent, 'export function greet() { return "hello world"; }\n');

  // Task commit transition
  await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  const taskAfter = await KruschStateManager.getTask(taskId);
  assert.strictEqual(taskAfter.phase, HARNESS_PHASES.COMMITTED);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
