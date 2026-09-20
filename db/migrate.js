import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const connectionString = process.env.DATABASE_URL || 'postgresql://kdcode:password@localhost:5432/kdcode';

export async function migrate() {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS krusch_schema_migrations (
        version VARCHAR(128) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Fetch already applied versions
    const appliedRes = await client.query('SELECT version FROM krusch_schema_migrations');
    const appliedSet = new Set(appliedRes.rows.map(r => r.version));

    // 3. Scan and sort migration files
    const migrationsDir = path.resolve(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;

    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (!appliedSet.has(version)) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        console.log(`Applying migration: ${file}...`);
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO krusch_schema_migrations (version, applied_at) VALUES ($1, NOW())',
            [version]
          );
          await client.query('COMMIT');
          console.log(`✓ Applied migration ${file}`);
          appliedCount++;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`✗ Migration ${file} failed:`, err.message);
          throw err;
        }
      }
    }

    if (appliedCount === 0) {
      console.log('✓ Krusch database schema is up to date (no pending migrations).');
    } else {
      console.log(`✓ Applied ${appliedCount} migration(s) successfully.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch(() => process.exit(1));
}
