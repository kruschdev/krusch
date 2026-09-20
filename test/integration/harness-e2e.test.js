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

test('Integration E2E: Harness executes real repo edit end-to-end (run -> fail tests -> restage -> pass -> apply -> commit)', async () => {
  // 1. Create real project workspace with deliberate initial bug
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-e2e-repo-'));
  const srcDir = path.join(testDir, 'src');
  const testSubDir = path.join(testDir, 'test');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testSubDir, { recursive: true });

  const initialBuggyCode = `export function add(a, b) {\n  return a - b; // buggy initial implementation\n}\n`;
  const flawedStagedCode = `export function add(a, b) {\n  return a * b; // flawed first attempt\n}\n`;
  const correctStagedCode = `export function add(a, b) {\n  return a + b; // correct fix\n}\n`;

  const calcFile = path.join(srcDir, 'calculator.js');
  fs.writeFileSync(calcFile, initialBuggyCode, 'utf-8');

  // Package manifest for ESM import resolution
  fs.writeFileSync(
    path.join(testDir, 'package.json'),
    JSON.stringify({ name: 'e2e-calc', type: 'module' }, null, 2),
    'utf-8'
  );

  // Ground truth test script in workspace
  const testScript = path.join(testSubDir, 'calculator.test.js');
  fs.writeFileSync(
    testScript,
    `import assert from 'node:assert';\nimport { add } from '../src/calculator.js';\nassert.strictEqual(add(2, 3), 5, 'add(2, 3) must equal 5');\nconsole.log('Calculator test passed!');\n`,
    'utf-8'
  );

  // 2. Program deterministic MockModelAdapter for the end-to-end trajectory:
  // Turn 1 (PLAN): Model inspects buggy file via read_file
  // Turn 2 (IMPLEMENT): Model stages flawed fix via stage_diff
  // Turn 3 (VERIFY): Model runs verification test, which fails
  // Turn 4 (IMPLEMENT): Model restages correct fix via stage_diff
  // Turn 5 (VERIFY): Model runs verification test, which passes
  const mock = new MockModelAdapter();

  // Turn 1 (PLAN): Inspect repository
  mock.setNextResponse({
    text: 'Examining buggy calculator implementation.',
    toolCalls: [
      {
        id: 'call_turn1_read',
        name: 'read_file',
        args: { path: 'src/calculator.js' }
      }
    ],
    usage: { total_tokens: 80, prompt_tokens: 50, completion_tokens: 30 },
    latencyMs: 10
  });

  // Turn 2 (IMPLEMENT): Stage flawed fix
  mock.setNextResponse({
    text: 'Staging initial fix into PostgreSQL.',
    toolCalls: [
      {
        id: 'call_turn2_stage',
        name: 'stage_diff',
        args: {
          path: 'src/calculator.js',
          content: flawedStagedCode,
          explanation: 'Initial fix attempt'
        }
      }
    ],
    usage: { total_tokens: 110, prompt_tokens: 70, completion_tokens: 40 },
    latencyMs: 12
  });

  // Turn 3 (VERIFY): Run failing verification
  mock.setNextResponse({
    text: 'Running verification test suite.',
    toolCalls: [
      {
        id: 'call_turn3_verify',
        name: 'run_command',
        args: {
          command: 'node -e "console.error(\'AssertionError: Expected 5 but got 6\'); process.exit(1);"'
        }
      }
    ],
    usage: { total_tokens: 90, prompt_tokens: 60, completion_tokens: 30 },
    latencyMs: 15
  });

  // Turn 4 (IMPLEMENT): Restage correct fix
  mock.setNextResponse({
    text: 'Restaging correct addition logic following test failure diagnosis.',
    toolCalls: [
      {
        id: 'call_turn4_stage',
        name: 'stage_diff',
        args: {
          path: 'src/calculator.js',
          content: correctStagedCode,
          explanation: 'Restaged correct addition logic'
        }
      }
    ],
    usage: { total_tokens: 120, prompt_tokens: 75, completion_tokens: 45 },
    latencyMs: 12
  });

  // Turn 5 (VERIFY): Run passing verification
  mock.setNextResponse({
    text: 'Re-running verification test suite.',
    toolCalls: [
      {
        id: 'call_turn5_verify',
        name: 'run_command',
        args: {
          command: 'node -e "console.log(\'Verification passed: add(2, 3) === 5\'); process.exit(0);"'
        }
      }
    ],
    usage: { total_tokens: 90, prompt_tokens: 60, completion_tokens: 30 },
    latencyMs: 10
  });

  // 3. Execute KruschStateMachine harness
  const harness = new KruschStateMachine({
    autoApprove: true,
    useMock: true,
    mockAdapter: mock
  });

  const result = await harness.runTask({
    goal: 'Fix add function in src/calculator.js and verify test suite',
    projectPath: testDir,
    maxTurns: 6
  });

  // 4. Assert Harness Execution Result
  assert.strictEqual(result.status, HARNESS_PHASES.COMMITTED, 'Task must reach COMMITTED state');
  assert.strictEqual(result.turnsExecuted, 5, 'Exactly 5 phased turns (plan, stage, verify-fail, restage, verify-pass) should execute');
  assert.strictEqual(result.stagedDiffsCount, 1, 'Single staged diff lifecycle tracked');

  // 5. Verify PostgreSQL State
  const task = await KruschStateManager.getTask(result.taskId);
  assert.strictEqual(task.phase, HARNESS_PHASES.COMMITTED, 'PostgreSQL task phase must be COMMITTED');

  const diffs = await query(
    'SELECT * FROM krusch_staged_diffs WHERE task_id = $1 ORDER BY id ASC',
    [result.taskId]
  );
  assert.strictEqual(diffs.rows.length, 1);
  const diffRow = diffs.rows[0];
  assert.strictEqual(diffRow.file_path, 'src/calculator.js');
  assert.strictEqual(diffRow.status, 'COMMITTED', 'Diff status must be promoted to COMMITTED upon task commit');
  assert.ok(diffRow.applied_at, 'applied_at timestamp must be recorded');

  // Verify verification runs recorded in PostgreSQL
  const verifications = await query(
    'SELECT * FROM krusch_verification_runs WHERE task_id = $1 ORDER BY id ASC',
    [result.taskId]
  );
  assert.strictEqual(verifications.rows.length, 2, 'Two verification runs must be recorded in PostgreSQL');
  assert.strictEqual(verifications.rows[0].passed, false, 'First verification run must be recorded as failed');
  assert.strictEqual(verifications.rows[0].exit_code, 1);
  assert.strictEqual(verifications.rows[1].passed, true, 'Second verification run must be recorded as passed');
  assert.strictEqual(verifications.rows[1].exit_code, 0);

  // 6. Verify Physical File on Disk
  const finalDiskContent = fs.readFileSync(calcFile, 'utf-8');
  assert.strictEqual(finalDiskContent, correctStagedCode, 'Physical disk file must contain the committed code');

  // 7. Verify real ground-truth test passes on physical disk now that diff is applied!
  const finalGroundTruthTest = await KruschTestRunner.runCommand(`node test/calculator.test.js`, testDir);
  assert.strictEqual(finalGroundTruthTest.passed, true, 'Physical test suite must pass after atomic apply');
  assert.strictEqual(finalGroundTruthTest.exitCode, 0);

  // 8. Capture and Save E2E Trajectory Fixture
  const fixtureData = {
    taskId: result.taskId,
    goal: task.goal,
    projectPath: testDir,
    finalStatus: result.status,
    turnsExecuted: result.turnsExecuted,
    turns: task.turns.map(t => ({
      turnNumber: t.turn_number,
      modelId: t.model_id,
      outputText: t.output_text,
      routingStage: t.routing_stage
    })),
    verifications: verifications.rows.map(v => ({
      id: v.id,
      command: v.command,
      exitCode: v.exit_code,
      passed: v.passed,
      createdAt: v.created_at
    })),
    stagedDiff: {
      id: diffRow.id,
      filePath: diffRow.file_path,
      originalSha256: diffRow.original_sha256,
      stagedSha256: diffRow.sha256_hash,
      status: diffRow.status,
      appliedAt: diffRow.applied_at
    },
    diskVerification: {
      command: 'node test/calculator.test.js',
      passed: finalGroundTruthTest.passed,
      exitCode: finalGroundTruthTest.exitCode,
      stdout: finalGroundTruthTest.stdout
    },
    recordedAt: new Date().toISOString()
  };

  const fixturePath = path.resolve(process.cwd(), 'test/fixtures/e2e-run.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixtureData, null, 2), 'utf-8');
  assert.ok(fs.existsSync(fixturePath), 'Fixture test/fixtures/e2e-run.json must exist');

  // Clean up temporary repo
  fs.rmSync(testDir, { recursive: true, force: true });
});

test.after(async () => {
  await pool.end();
});
