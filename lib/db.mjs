import { readFile } from 'node:fs/promises';
import pg from 'pg';
let ready;
export async function getDb() {
  if (!ready) ready = initialize().catch(e => { ready = null; throw e; });
  return ready;
}
async function initialize() {
  let db;
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
    db = { query: (q, p) => pool.query(q, p), async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
      catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }, close: () => pool.end() };
  } else {
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
    const { PGlite } = await import('@electric-sql/pglite');
    const local = new PGlite(process.env.LOCAL_DB_PATH || './.data/ballot');
    db = { query: (q,p) => local.query(q,p), transaction: fn => local.transaction(fn), close: () => local.close() };
  }
  // Idempotent schema bootstrap; migrations after v1 must be explicit and additive.
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(7112026)");
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.split(';').filter(s => s.trim())) await tx.query(statement);
  });
  return db;
}
