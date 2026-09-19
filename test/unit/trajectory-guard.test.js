import test from 'node:test';
import assert from 'node:assert';
import { KruschTrajectoryGuard } from '../../src/workflow/trajectory-guard.js';

test('KruschTrajectoryGuard: detects repetitive n-gram loops', () => {
  const guard = new KruschTrajectoryGuard();
  const loopText = 'The system is retrying the connection to server now. ' +
    'The system is retrying the connection to server now. ' +
    'The system is retrying the connection to server now. ' +
    'The system is retrying the connection to server now. ' +
    'The system is retrying the connection to server now. ' +
    'The system is retrying the connection to server now. ';

  const isLoop = guard.detectRepetitionLoop(loopText);
  assert.strictEqual(isLoop, true);
});

test('KruschTrajectoryGuard: triggers escalation on consecutive tool failures', () => {
  const guard = new KruschTrajectoryGuard({ maxConsecutiveToolErrors: 3 });
  const history = [
    { toolError: true },
    { toolError: true },
    { toolError: true }
  ];

  const evaluation = guard.evaluateTrajectory(history);
  assert.strictEqual(evaluation.healthy, false);
  assert.strictEqual(evaluation.action, 'ESCALATE_TO_FRONTIER');
});

test('KruschTrajectoryGuard: passes on healthy varied trajectory', () => {
  const guard = new KruschTrajectoryGuard();
  const history = [
    { outputText: 'Analyzing code symbols and structure in index.js', toolError: false },
    { outputText: 'Found missing export, now staging fix in db', toolError: false }
  ];

  const evaluation = guard.evaluateTrajectory(history);
  assert.strictEqual(evaluation.healthy, true);
});
