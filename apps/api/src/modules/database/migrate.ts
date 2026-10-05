import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
export async function migrate(
  pool: Pool,
  directory = resolve(process.cwd(), 'migrations'),
) {
  const sql = await pool.connect();
  let locked = false;
  let discard = false;
  let failed = false;
  let failure: unknown;
  const rollback = async () => {
    try {
      await sql.query('ROLLBACK');
    } catch {
      discard = true;
    }
  };
  try {
    // SET LOCAL bounds acquisition without changing pooled session defaults.
    // The session advisory lock survives COMMIT and protects the whole run.
    try {
      await sql.query('BEGIN');
      await sql.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'",
      );
      await sql.query(
        "SELECT pg_advisory_lock(hashtextextended('raui:migrations',0))",
      );
      locked = true;
      await sql.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      await sql.query('COMMIT');
    } catch (error) {
      await rollback();
      throw error;
    }
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+_.+\.sql$/.test(n))
      .sort()) {
      const body = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const existing = (
        await sql.query<{ checksum: string }>(
          'SELECT checksum FROM schema_migrations WHERE name=$1',
          [name],
        )
      ).rows[0];
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      try {
        await sql.query('BEGIN');
        await sql.query(
          "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'",
        );
        // Older checked-in SQL includes an outer BEGIN/COMMIT. Execute its
        // contents within our transaction so schema and checksum stay atomic.
        // The checksum always covers the original immutable source bytes.
        const outer = body.trim().match(/^BEGIN;([\s\S]*)COMMIT;$/i);
        await sql.query(outer ? outer[1]! : body);
        await sql.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, checksum],
        );
        await sql.query('COMMIT');
      } catch (error) {
        await rollback();
        throw error;
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      if (locked && !discard)
        await sql.query(
          "SELECT pg_advisory_unlock(hashtextextended('raui:migrations',0))",
        );
    } catch (error) {
      discard = true;
      if (!failed) {
        failed = true;
        failure = error;
      }
    } finally {
      // A failed cleanup must not return a transaction/lock-bearing connection.
      sql.release(discard);
    }
  }
  if (failed) throw failure;
}
if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  void migrate(pool)
    .then(() => console.log('Migrations applied'))
    .catch(() => {
      console.error('Migration failed; inspect local database diagnostics');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
