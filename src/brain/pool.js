import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const connectionString = process.env.DATABASE_URL || 'postgresql://kdcode:password@localhost:5432/kdcode';

let activePool = null;

export function getPool() {
  if (!activePool || activePool.ending || activePool.ended) {
    activePool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return activePool;
}

export const pool = {
  query: (...args) => getPool().query(...args),
  connect: () => getPool().connect(),
  end: () => (activePool ? activePool.end() : Promise.resolve()),
};

export async function query(text, params) {
  try {
    const res = await getPool().query(text, params);
    return res;
  } catch (err) {
    console.error(`[krusch:db] Query error: "${text.slice(0, 100)}..." -> ${err.message}`);
    throw err;
  }
}

export async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
