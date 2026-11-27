import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export async function assertAppliedMigrations(pool: Pool) {
  const names = (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(names.length > 0);
  const expected = await Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(resolve('migrations', name)))
        .digest('hex'),
    })),
  );
  const applied = await pool.query(
    'SELECT name, checksum FROM schema_migrations ORDER BY name',
  );
  assert.deepEqual(applied.rows, expected);
}
