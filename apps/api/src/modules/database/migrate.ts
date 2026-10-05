import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
export async function migrate(
  pool: Pool,
  directory = resolve(process.cwd(), 'migrations'),
) {
  const sql = await pool.connect();
  try {
    await sql.query(
      "SELECT pg_advisory_lock(hashtextextended('raui:migrations',0))",
    );
    await sql.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
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
      await sql.query('BEGIN');
      try {
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
        await sql.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await sql.query(
      "SELECT pg_advisory_unlock(hashtextextended('raui:migrations',0))",
    );
    sql.release();
  }
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
