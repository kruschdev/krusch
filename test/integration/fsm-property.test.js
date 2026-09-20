import test from 'node:test';
import assert from 'node:assert';
import { query, pool } from '../../src/brain/pool.js';
import { KruschStateManager } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('FSM Property Test: PostgreSQL catalog krusch_phase_edges rejects 100% of illegal transitions', async () => {
  // 1. Fetch authoritative phase edges from database catalog
  const catalogRes = await query('SELECT from_phase, to_phase FROM krusch_phase_edges');
  const legalEdges = new Set(catalogRes.rows.map(r => `${r.from_phase}->${r.to_phase}`));

  const allPhases = [
    HARNESS_PHASES.INIT,
    HARNESS_PHASES.PLAN,
    HARNESS_PHASES.IMPLEMENT,
    HARNESS_PHASES.VERIFY,
    HARNESS_PHASES.APPROVAL_GATE,
    HARNESS_PHASES.COMMITTED,
    HARNESS_PHASES.ABORTED
  ];

  let illegalTested = 0;

  for (const fromPhase of allPhases) {
    for (const toPhase of allPhases) {
      if (fromPhase === toPhase) continue;

      const edgeKey = `${fromPhase}->${toPhase}`;
      const isLegal = legalEdges.has(edgeKey);

      if (!isLegal) {
        illegalTested++;
        const taskId = `prop_illegal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // Seed task in fromPhase directly via SQL
        await query(
          `INSERT INTO krusch_tasks (id, goal, project_path, phase) VALUES ($1, $2, $3, $4)`,
          [taskId, `Property test for ${edgeKey}`, process.cwd(), fromPhase]
        );

        // Attempt illegal transition at the SQL layer
        let threw = false;
        let errorMessage = '';
        try {
          await query(`UPDATE krusch_tasks SET phase = $1 WHERE id = $2`, [toPhase, taskId]);
        } catch (err) {
          threw = true;
          errorMessage = err.message;
        }

        assert.strictEqual(
          threw,
          true,
          `DATABASE INVARIANT LEAK: Illegal transition ${edgeKey} succeeded without trigger rejection!`
        );
        assert.ok(
          errorMessage.includes('Invalid FSM transition') ||
          errorMessage.includes('Terminal state') ||
          errorMessage.includes('check_violation') ||
          errorMessage.includes('check constraint'),
          `Unexpected error for ${edgeKey}: ${errorMessage}`
        );

        // Clean up task
        await query('DELETE FROM krusch_tasks WHERE id = $1', [taskId]);
      }
    }
  }

  assert.strictEqual(illegalTested, 49 - 7 - legalEdges.size);
  assert.ok(illegalTested > 25, `Expected > 25 illegal transitions tested, got ${illegalTested}`);
});

test('FSM Property Test: Expired leases never block subsequent tasks after pruning', async () => {
  const taskIdOld = `task_old_${Date.now()}`;
  const taskIdNew = `task_new_${Date.now()}`;
  const testFile = 'property_test_lease.js';

  // Task Old stages file
  await KruschStateManager.createTask({
    id: taskIdOld,
    goal: 'Old task holding lease',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.IMPLEMENT
  });

  const staged = await KruschStateManager.stageDiff(taskIdOld, {
    filePath: testFile,
    originalContent: '// old base',
    stagedContent: '// old modified',
    diffPatch: 'patch',
    projectPath: process.cwd(),
    ttlMinutes: 15
  });

  // Manually expire lease in PostgreSQL
  await query(`
    UPDATE krusch_staged_diffs
    SET lease_expires_at = NOW() - interval '1 hour'
    WHERE id = $1
  `, [staged.id]);

  // Prune expired leases
  const pruned = await KruschStateManager.pruneExpiredLeases();
  assert.ok(pruned.some(p => p.id === staged.id));

  // Now Task New can acquire lease without conflict
  await KruschStateManager.createTask({
    id: taskIdNew,
    goal: 'New task claiming lease',
    projectPath: process.cwd(),
    phase: HARNESS_PHASES.IMPLEMENT
  });

  const stagedNew = await KruschStateManager.stageDiff(taskIdNew, {
    filePath: testFile,
    originalContent: '// old base',
    stagedContent: '// new modified',
    diffPatch: 'patch new',
    projectPath: process.cwd(),
    ttlMinutes: 15
  });

  assert.ok(stagedNew.id);
  assert.strictEqual(stagedNew.task_id, taskIdNew);

  // Clean up
  await query('DELETE FROM krusch_tasks WHERE id IN ($1, $2)', [taskIdOld, taskIdNew]);
});

test.after(async () => {
  await pool.end();
});
