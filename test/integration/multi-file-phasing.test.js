import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { query, pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { KruschStateMachine } from '../../src/workflow/state-machine.js';
import { MockModelAdapter } from '../../src/models/providers/mock.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';
import { KruschTestRunner } from '../../src/verify/test-runner.js';

test('Integration: Multi-turn PLAN, multi-file staging in IMPLEMENT, and VERIFY transition', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-multi-file-'));
  const srcDir = path.join(testDir, 'src');
  const testSubDir = path.join(testDir, 'test');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testSubDir, { recursive: true });

  // Two files that both need edits
  const mathFile = path.join(srcDir, 'math.js');
  const formatFile = path.join(srcDir, 'formatter.js');
  fs.writeFileSync(mathFile, 'export function multiply(a, b) { return a + b; }\n', 'utf-8'); // Bug: adds instead of multiplies
  fs.writeFileSync(formatFile, 'export function formatResult(val) { return `RES: ${val}`; }\n', 'utf-8');

  // Package manifest for ESM
  fs.writeFileSync(
    path.join(testDir, 'package.json'),
    JSON.stringify({ name: 'multi-file-test', type: 'module' }, null, 2),
    'utf-8'
  );

  // Ground truth test requiring both files to be correct
  const testScript = path.join(testSubDir, 'app.test.js');
  fs.writeFileSync(
    testScript,
    `import assert from 'node:assert';
import { multiply } from '../src/math.js';
import { formatResult } from '../src/formatter.js';
assert.strictEqual(multiply(3, 4), 12, 'multiply(3, 4) must be 12');
assert.strictEqual(formatResult(12), 'RESULT: 12', 'formatter must prefix RESULT:');
console.log('Multi-file test passed!');
`,
    'utf-8'
  );

  const mock = new MockModelAdapter();

  // Turn 1 (PLAN): Inspect first file only -> Must stay in PLAN!
  mock.setNextResponse({
    text: 'Reading math.js in PLAN phase.',
    toolCalls: [
      { id: 't1_read_math', name: 'read_file', args: { path: 'src/math.js' } }
    ],
    usage: { total_tokens: 50 },
    latencyMs: 10
  });

  // Turn 2 (PLAN): Inspect second file, then finish plan -> Transition to IMPLEMENT!
  mock.setNextResponse({
    text: 'Reading formatter.js and concluding plan.',
    toolCalls: [
      { id: 't2_read_fmt', name: 'read_file', args: { path: 'src/formatter.js' } },
      { id: 't2_finish_plan', name: 'finish_plan', args: { planSummary: 'Update math.js multiply and formatter.js prefix' } }
    ],
    usage: { total_tokens: 70 },
    latencyMs: 10
  });

  // Turn 3 (IMPLEMENT): Stage file 1 of 2 -> Must stay in IMPLEMENT (VERIFY must not yank yet!)
  mock.setNextResponse({
    text: 'Staging fix for math.js (file 1 of 2).',
    toolCalls: [
      {
        id: 't3_stage_math',
        name: 'stage_diff',
        args: {
          path: 'src/math.js',
          content: 'export function multiply(a, b) { return a * b; }\n',
          explanation: 'Fix multiplication logic'
        }
      }
    ],
    usage: { total_tokens: 80 },
    latencyMs: 10
  });

  // Turn 4 (IMPLEMENT): Stage file 2 of 2 and request verification -> Transition to VERIFY!
  mock.setNextResponse({
    text: 'Staging fix for formatter.js (file 2 of 2) and requesting verification.',
    toolCalls: [
      {
        id: 't4_stage_fmt',
        name: 'stage_diff',
        args: {
          path: 'src/formatter.js',
          content: 'export function formatResult(val) { return `RESULT: ${val}`; }\n',
          explanation: 'Fix prefix format'
        }
      },
      {
        id: 't4_req_verify',
        name: 'request_verification',
        args: { reason: 'Both math.js and formatter.js staged' }
      }
    ],
    usage: { total_tokens: 90 },
    latencyMs: 10
  });

  // Turn 5 (VERIFY): Run verification command -> Pass!
  mock.setNextResponse({
    text: 'Running verification test on multi-file changes.',
    toolCalls: [
      {
        id: 't5_run_cmd',
        name: 'run_command',
        args: { command: 'node -e "console.log(\'Multi-file verification passed\'); process.exit(0);"' }
      }
    ],
    usage: { total_tokens: 80 },
    latencyMs: 10
  });

  const harness = new KruschStateMachine({
    autoApprove: true,
    useMock: true,
    mockAdapter: mock
  });

  const result = await harness.runTask({
    goal: 'Fix multiply in math.js and prefix in formatter.js',
    projectPath: testDir,
    maxTurns: 8
  });

  assert.strictEqual(result.status, HARNESS_PHASES.COMMITTED);
  assert.strictEqual(result.turnsExecuted, 5);
  assert.strictEqual(result.stagedDiffsCount, 2, 'Must stage and commit 2 separate files');

  // Verify physical files on disk
  assert.strictEqual(fs.readFileSync(mathFile, 'utf-8'), 'export function multiply(a, b) { return a * b; }\n');
  assert.strictEqual(fs.readFileSync(formatFile, 'utf-8'), 'export function formatResult(val) { return `RESULT: ${val}`; }\n');

  // Verify test passes on disk
  const verifyResult = await KruschTestRunner.runCommand('node test/app.test.js', testDir);
  assert.strictEqual(verifyResult.passed, true);
  assert.strictEqual(verifyResult.exitCode, 0);

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('Integration: Phase revisit budget caps VERIFY -> IMPLEMENT oscillation and aborts task', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-cap-test-'));
  fs.writeFileSync(path.join(testDir, 'broken.js'), 'export const x = 1;\n', 'utf-8');

  const mock = new MockModelAdapter();

  // Turn 1 (PLAN): finish plan directly
  mock.setNextResponse({
    text: 'Plan finished.',
    toolCalls: [{ id: 'p1', name: 'finish_plan', args: {} }]
  });

  // Turn 2 (IMPLEMENT): stage diff and request verify
  mock.setNextResponse({
    text: 'Stage diff.',
    toolCalls: [
      { id: 's1', name: 'stage_diff', args: { path: 'broken.js', content: 'export const x = 2;\n' } },
      { id: 'rv1', name: 'request_verification', args: {} }
    ]
  });

  // Turn 3 (VERIFY): Failing run 1
  mock.setNextResponse({
    text: 'Run test (fail 1)',
    toolCalls: [{ id: 'r1', name: 'run_command', args: { command: 'node -e "process.exit(1)"' } }]
  });

  // Turn 4 (IMPLEMENT): restage 1 and request verify
  mock.setNextResponse({
    text: 'Restage 1.',
    toolCalls: [
      { id: 's2', name: 'stage_diff', args: { path: 'broken.js', content: 'export const x = 3;\n' } },
      { id: 'rv2', name: 'request_verification', args: {} }
    ]
  });

  // Turn 5 (VERIFY): Failing run 2
  mock.setNextResponse({
    text: 'Run test (fail 2)',
    toolCalls: [{ id: 'r2', name: 'run_command', args: { command: 'node -e "process.exit(1)"' } }]
  });

  // Turn 6 (IMPLEMENT): restage 2 and request verify
  mock.setNextResponse({
    text: 'Restage 2.',
    toolCalls: [
      { id: 's3', name: 'stage_diff', args: { path: 'broken.js', content: 'export const x = 4;\n' } },
      { id: 'rv3', name: 'request_verification', args: {} }
    ]
  });

  // Turn 7 (VERIFY): Failing run 3 -> should hit cap (maxPhaseRevisits = 2) and ABORT!
  mock.setNextResponse({
    text: 'Run test (fail 3)',
    toolCalls: [{ id: 'r3', name: 'run_command', args: { command: 'node -e "process.exit(1)"' } }]
  });

  const harness = new KruschStateMachine({
    autoApprove: true,
    useMock: true,
    mockAdapter: mock,
    maxPhaseRevisits: 2 // Cap at 2 revisits
  });

  const result = await harness.runTask({
    goal: 'Test oscillation revisit cap',
    projectPath: testDir,
    maxTurns: 10
  });

  assert.strictEqual(result.status, HARNESS_PHASES.ABORTED, 'Task must abort when retry budget is exceeded');
  assert.ok(result.reason.includes('Exceeded maximum verification retry budget'));

  const task = await KruschStateManager.getTask(result.taskId);
  assert.strictEqual(task.phase, HARNESS_PHASES.ABORTED);

  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
