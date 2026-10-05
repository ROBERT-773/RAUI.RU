import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import {
  cleanupRecovery,
  localDatabase,
  restoreName,
  objectKey,
  cipherFor,
  decipherFor,
  seal,
  open,
} from './recovery.mjs';
const source = localDatabase(process.env.DATABASE_URL ?? '');
const target = restoreName(
  'raui_restore_test_' + randomBytes(8).toString('hex'),
);
const pool = new Pool({
  connectionString: source.toString(),
  max: 2,
  connectionTimeoutMillis: 3000,
  statement_timeout: 30000,
});
const snapshot = await pool.connect();
const privateRoot = resolve('../../.cache/recovery');
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(privateRoot + '/drill-');
const key = randomBytes(32),
  nonce = randomBytes(12),
  started = performance.now();
let created = false;
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
async function fingerprint(sql) {
  const tables = (
    await sql.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result = [];
  for (const { tablename } of tables) {
    const row = (
      await sql.query(
        `SELECT count(*)::text AS count,COALESCE(sum(('x'||substr(md5(row_to_json(t)::text),1,15))::bit(60)::bigint),0)::text AS digest FROM public.${quote(tablename)} t`,
      )
    ).rows[0];
    result.push({ table: tablename, ...row });
  }
  const sequenceRows = (
    await sql.query(
      "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
    )
  ).rows;
  const migrations = (
    await sql.query('SELECT name,checksum FROM schema_migrations ORDER BY name')
  ).rows;
  const postgis = (await sql.query('SELECT PostGIS_Version() AS version'))
    .rows[0].version;
  return { tables: result, sequences: sequenceRows, migrations, postgis };
}
function pg(args, input = 'ignore') {
  const child = spawn(
    'docker',
    [
      'compose',
      '--env-file',
      '../../.env',
      '-f',
      '../../infra/compose.yaml',
      'exec',
      '-T',
      'postgres',
      ...args,
    ],
    { stdio: [input, 'pipe', 'pipe'] },
  );
  child.stderr.on('data', () => {}); // raw PG diagnostics can contain private row values
  const completion = new Promise((done, reject) => {
    child.once('error', () => reject(new Error('Local recovery tool failed')));
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error('Local recovery tool failed')),
    );
  });
  completion.catch(() => {});
  return { child, completion };
}
try {
  await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const exported = (
    await snapshot.query('SELECT pg_export_snapshot() AS snapshot')
  ).rows[0].snapshot;
  const expected = await fingerprint(snapshot);
  const encrypted = resolve(directory, 'database.gcm');
  const cipher = cipherFor(key, nonce);
  const dump = pg([
    'pg_dump',
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--username',
    decodeURIComponent(source.username),
    '--dbname',
    source.pathname.slice(1),
    '--snapshot',
    exported,
  ]);
  await pipeline(
    dump.child.stdout,
    cipher,
    createWriteStream(encrypted, { mode: 0o600, flags: 'wx' }),
  );
  await dump.completion;
  const dumpMs = performance.now() - started;
  await snapshot.query('COMMIT');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(encrypted)) hash.update(bytes);
  const checksum = hash.digest('hex');
  await writeFile(
    resolve(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      cipher: 'AES-256-GCM',
      nonce: nonce.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      sha256: checksum,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const plaintext = resolve(directory, 'authenticated.dump');
  await pipeline(
    createReadStream(encrypted),
    decipherFor(key, nonce, cipher.getAuthTag()),
    createWriteStream(plaintext, { mode: 0o600, flags: 'wx' }),
  );
  await pool.query(`CREATE DATABASE ${quote(target)}`);
  created = true;
  const restore = pg(
    [
      'pg_restore',
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--username',
      decodeURIComponent(source.username),
      '--dbname',
      target,
    ],
    'pipe',
  );
  await pipeline(createReadStream(plaintext), restore.child.stdin);
  await restore.completion;
  const restoredUrl = new URL(source);
  restoredUrl.pathname = '/' + target;
  const restored = new Pool({
    connectionString: restoredUrl.toString(),
    statement_timeout: 30000,
  });
  try {
    assert.deepEqual(await fingerprint(restored), expected);
  } finally {
    await restored.end();
  }
  // Exercise authenticated private-object backup and identity without touching real media.
  const fixture = Buffer.from(
    'RAUI private fixture ' + randomBytes(32).toString('hex'),
  );
  const object = objectKey('media/fixture.bin');
  const ciphertext = seal(fixture, key);
  await mkdir(resolve(directory, 'objects/media'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(resolve(directory, 'objects', object) + '.gcm', ciphertext, {
    mode: 0o600,
    flag: 'wx',
  });
  assert.deepEqual(
    open(await readFile(resolve(directory, 'objects', object) + '.gcm'), key),
    fixture,
  );
  const evidence = {
    version: 1,
    measuredAt: new Date().toISOString(),
    sourceUntouched: true,
    databaseRestore: 'verified',
    objectFixtureRestore: 'verified',
    cipher: 'AES-256-GCM',
    databaseDumpMs: dumpMs,
    totalDrillMs: performance.now() - started,
    tablesVerified: expected.tables.length,
    migrationsVerified: expected.migrations.length,
    sequencesVerified: expected.sequences.length,
    postgis: expected.postgis,
    encryptedSha256: checksum,
    coverage:
      'local consistent DB snapshot and fixture object; not remote S3 or production standby certification',
  };
  await writeFile(
    resolve('../../.cache/phase4d-recovery.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Encrypted consistent-snapshot restore verified: domain/audit rows, sequences, migrations and PostGIS; original source untouched',
  );
} finally {
  await snapshot.query('ROLLBACK').catch(() => {});
  snapshot.release();
  await cleanupRecovery({
    drop: async () => {
      if (created)
        await pool.query(`DROP DATABASE ${quote(target)} WITH (FORCE)`);
    },
    end: () => pool.end(),
    wipe: () => key.fill(0),
    remove: () => rm(directory, { recursive: true, force: true }),
  });
}
