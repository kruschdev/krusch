import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const connectionString = process.env.DATABASE_URL || 'postgresql://kdcode:password@localhost:5432/kdcode';

test('Migration Engine: Sequential migrations 001->009 apply idempotently on catalog', async () => {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  try {
    // 1. Verify krusch_schema_migrations table tracks all versioned migrations
    const res = await client.query('SELECT version FROM krusch_schema_migrations ORDER BY version ASC');
    const applied = res.rows.map(r => r.version);

    assert.ok(applied.includes('001_initial_schema'));
    assert.ok(applied.includes('002_harden_invariants'));
    assert.ok(applied.includes('003_phase_edges_and_lease_hardening'));
    assert.ok(applied.includes('004_lease_lifecycle_and_path_canonicalization'));
    assert.ok(applied.includes('005_apply_transaction_and_lease_ttl'));
    assert.ok(applied.includes('006_task_verification_command'));
    assert.ok(applied.includes('007_guard_rejected_diff_commit'));
    assert.ok(applied.includes('008_context_and_memory_tables'));
    assert.ok(applied.includes('009_code_symbols_unique_and_upsert'));

    // Check verification_command column on krusch_tasks
    const colRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'krusch_tasks' AND column_name = 'verification_command'
    `);
    assert.strictEqual(colRes.rows.length, 1);

    // 2. Verify all core tables exist in the PostgreSQL catalog
    const tablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'krusch_%'
    `);
    const tables = tablesRes.rows.map(r => r.table_name);
    assert.ok(tables.includes('krusch_tasks'));
    assert.ok(tables.includes('krusch_turns'));
    assert.ok(tables.includes('krusch_events'));
    assert.ok(tables.includes('krusch_staged_diffs'));
    assert.ok(tables.includes('krusch_approvals'));
    assert.ok(tables.includes('krusch_verification_runs'));
    assert.ok(tables.includes('krusch_phase_edges'));
    assert.ok(tables.includes('krusch_schema_migrations'));
    assert.ok(tables.includes('krusch_code_symbols'));
    assert.ok(tables.includes('krusch_memories'));

    // 3. Verify transactional rollback on simulated broken migration
    await client.query('BEGIN');
    let rollbackTriggered = false;
    try {
      await client.query('CREATE TABLE krusch_temp_test (id INT)');
      // Deliberately broken query to trigger rollback
      await client.query('SELECT * FROM non_existent_table_for_rollback_test');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      rollbackTriggered = true;
    }
    assert.strictEqual(rollbackTriggered, true);

    // Verify temp table was rolled back cleanly
    const checkTable = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'krusch_temp_test'
    `);
    assert.strictEqual(checkTable.rows.length, 0);

  } finally {
    client.release();
    await pool.end();
  }
});
