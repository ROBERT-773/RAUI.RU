import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { watchPoolErrors, boundedOperation } from './e2e-runtime.mjs';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import {
  cleanupRecovery,
  sequenceNextValue,
  localDatabase,
  restoreName,
  objectKey,
  cipherFor,
  decipherFor,
  seal,
  open,
} from './recovery.mjs';
async function run() {
  const source = localDatabase(process.env.DATABASE_URL ?? '');
  if (
    process.env.RECOVERY_SOURCE_QUIESCED !== 'true' ||
    !/^\/raui_test_[a-f0-9]{16}$/.test(source.pathname)
  )
    throw new Error('Controlled quiesced scratch source required');
  const target = restoreName(
    process.env.RECOVERY_RESTORE_TARGET ??
      'raui_restore_test_' + randomBytes(8).toString('hex'),
  );
  const pool = new Pool({
    connectionString: source.toString(),
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
  });
  let failed = false;
  const monitor = watchPoolErrors([pool], () => {
    failed = true;
  });
  let snapshot;
  const tools = [];
  const privateRoot = resolve('../../.cache/recovery');
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const suppliedDirectory = process.env.RECOVERY_PRIVATE_DIRECTORY;
  if (
    suppliedDirectory &&
    (dirname(resolve(suppliedDirectory)) !== privateRoot ||
      !/^drill-[A-Za-z0-9]{6}$/.test(basename(suppliedDirectory)))
  )
    throw new Error('Fresh private recovery workspace required');
  const directory = suppliedDirectory
    ? resolve(suppliedDirectory)
    : await mkdtemp(privateRoot + '/drill-');
  const key = randomBytes(32),
    nonce = randomBytes(12),
    started = performance.now();
  let created = false;
  let evidence;
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
    const sequenceConfigs = (
      await sql.query(
        "SELECT schemaname,sequencename,data_type::text,start_value::text,min_value::text,max_value::text,increment_by::text,cycle,cache_size::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
      )
    ).rows;
    const sequenceRows = [];
    for (const config of sequenceConfigs) {
      const state = (
        await sql.query(
          `SELECT last_value::text,is_called FROM ${quote(config.schemaname)}.${quote(config.sequencename)}`,
        )
      ).rows[0];
      sequenceRows.push({ ...config, ...state });
    }
    const migrations = (
      await sql.query(
        'SELECT name,checksum FROM schema_migrations ORDER BY name',
      )
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
      child.once('error', () =>
        reject(new Error('Local recovery tool failed')),
      );
      child.once('exit', (code) =>
        code === 0 ? done() : reject(new Error('Local recovery tool failed')),
      );
    });
    completion.catch(() => {});
    tools.push({ child, completion });
    return { child, completion };
  }
  try {
    // Acquire resources to completion before cleanup records ownership.
    snapshot = await pool.connect();
    await monitor.run(() =>
      snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    );
    const exported = (
      await snapshot.query('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0].snapshot;
    const expected = await monitor.run(() => fingerprint(snapshot));
    assert.equal(expected.migrations.length, 15);
    assert.ok(expected.sequences.some((s) => s.is_called));
    assert.ok(expected.sequences.some((s) => !s.is_called));
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
    await monitor.run(() =>
      pipeline(
        dump.child.stdout,
        cipher,
        createWriteStream(encrypted, { mode: 0o600, flags: 'wx' }),
      ),
    );
    await monitor.run(() => dump.completion);
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
    await monitor.run(() =>
      pipeline(
        createReadStream(encrypted),
        decipherFor(key, nonce, cipher.getAuthTag()),
        createWriteStream(plaintext, { mode: 0o600, flags: 'wx' }),
      ),
    );
    if (!process.env.RECOVERY_RESTORE_TARGET) {
      await pool.query(`CREATE DATABASE ${quote(target)}`);
      created = true;
    }
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
    await monitor.run(() =>
      pipeline(createReadStream(plaintext), restore.child.stdin),
    );
    await monitor.run(() => restore.completion);
    const restoredUrl = new URL(source);
    restoredUrl.pathname = '/' + target;
    const restored = new Pool({
      connectionString: restoredUrl.toString(),
      statement_timeout: 30000,
      connectionTimeoutMillis: 3000,
      query_timeout: 35000,
    });
    const restoreMonitor = watchPoolErrors([restored], () => {
      failed = true;
    });
    try {
      assert.deepEqual(
        await restoreMonitor.run(() => fingerprint(restored)),
        expected,
      );
      for (const sequence of expected.sequences) {
        const qualified = `${quote(sequence.schemaname)}.${quote(sequence.sequencename)}`;
        const actual = (
          await restored.query('SELECT nextval($1::regclass)::text AS value', [
            qualified,
          ])
        ).rows[0].value;
        assert.equal(actual, sequenceNextValue(sequence));
      }
    } finally {
      await boundedOperation(() => restored.end(), 5000);
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
    await writeFile(
      resolve(directory, 'objects', object) + '.gcm',
      ciphertext,
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    assert.deepEqual(
      open(await readFile(resolve(directory, 'objects', object) + '.gcm'), key),
      fixture,
    );
    if (failed) throw new Error('Recovery connection failed');
    evidence = {
      version: 1,
      measuredAt: new Date().toISOString(),
      sourceUntouched: true,
      sourceWritersQuiesced: true,
      databaseRestore: 'verified',
      objectFixtureRestore: 'verified',
      cipher: 'AES-256-GCM',
      databaseDumpMs: dumpMs,
      totalDrillMs: performance.now() - started,
      tablesVerified: expected.tables.length,
      migrationsVerified: expected.migrations.length,
      sequencesVerified: expected.sequences.length,
      sequenceStateAndConfig: 'verified',
      sequenceNextValuesVerified: expected.sequences.length,
      pristineSequencesVerified: expected.sequences.filter((s) => !s.is_called)
        .length,
      calledSequencesVerified: expected.sequences.filter((s) => s.is_called)
        .length,
      postgis: expected.postgis,
      encryptedSha256: checksum,
      coverage:
        'local consistent DB snapshot and fixture object; not remote S3 or production standby certification',
    };
  } finally {
    for (const tool of tools) {
      if (tool.child.exitCode === null && tool.child.signalCode === null) {
        tool.child.kill('SIGTERM');
        try {
          await boundedOperation(() => tool.completion.catch(() => {}), 3000);
        } catch {
          tool.child.kill('SIGKILL');
          await boundedOperation(
            () => tool.completion.catch(() => {}),
            2000,
          ).catch(() => {
            failed = true;
          });
        }
      }
    }
    if (snapshot) {
      await boundedOperation(() => snapshot.query('ROLLBACK'), 5000).catch(
        () => {
          failed = true;
        },
      );
      snapshot.release();
    }
    await cleanupRecovery({
      drop: async () => {
        if (created)
          await boundedOperation(
            () => pool.query(`DROP DATABASE ${quote(target)} WITH (FORCE)`),
            10000,
          );
      },
      end: () => boundedOperation(() => pool.end(), 5000),
      wipe: () => key.fill(0),
      remove: () =>
        suppliedDirectory
          ? Promise.resolve()
          : rm(directory, { recursive: true, force: true }),
    });
  }
  if (failed) throw new Error('Recovery lifecycle failed');
  return {
    evidence,
    path: suppliedDirectory
      ? resolve(directory, 'recovery-result.json')
      : resolve('../../.cache/phase4d-recovery.json'),
  };
}
try {
  const result = await run();
  await writeFile(
    result.path,
    JSON.stringify(result.evidence, null, 2) + '\n',
    { mode: 0o600, flag: process.env.RECOVERY_PRIVATE_DIRECTORY ? 'wx' : 'w' },
  );
} catch {
  console.error(
    'Recovery drill failed; inspect safe local fixture and cleanup status',
  );
  process.exitCode = 1;
}
