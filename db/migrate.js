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
  try {
    const schemaPath = path.resolve(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    await pool.query(sql);
    console.log('✓ Crush database schema migrated successfully.');
  } catch (err) {
    console.error('✗ Crush database migration failed:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch(() => process.exit(1));
}
