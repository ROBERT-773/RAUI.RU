import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  localDatabase,
  createRecoveryWorkspace,
  publishRecoveryEvidence,
  restoreName,
} from './recovery.mjs';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { watchPoolErrors, boundedOperation } from './e2e-runtime.mjs';

async function run() {
  const source = localDatabase(process.env.DATABASE_URL ?? '');
  const { migrate } = await import('../dist/modules/database/migrate.js');
  const name = 'raui_test_' + randomBytes(8).toString('hex');
  const target = restoreName(
    'raui_restore_test_' + randomBytes(8).toString('hex'),
  );
  let targetCreated = false;
  const options = {
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    query_timeout: 35000,
  };
  const admin = new Pool({ ...options, connectionString: source.toString() });
  source.pathname = '/' + name;
  const fixture = new Pool({ ...options, connectionString: source.toString() });
  let failed = false;
  const monitor = watchPoolErrors([admin, fixture], () => {
    failed = true;
  });
  let created = false;
  let fixtureEnding;
  const endFixture = () => (fixtureEnding ??= fixture.end());
  let child;
  let completion;
  let workspace;
  let evidence;
  try {
    // Allocation must settle before ownership is registered and cleanup starts.
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await monitor.run(() => migrate(fixture));
    await monitor.run(() =>
      fixture.query(
        "INSERT INTO audit_events(action,entity_type,entity_id,data) VALUES('rc.restore.fixture','fixture','restore','{\"preserve\":true}')",
      ),
    );
    await monitor.run(() =>
      fixture.query(`
      WITH actor AS (
        INSERT INTO users(email,password_hash,display_name,role,email_verified_at,phone_verified_at)
        VALUES('restore@fixture.test','disabled-recovery-fixture','RC restore','owner',now(),now()) RETURNING id
      ), address AS (
        INSERT INTO addresses(formatted,locality,point) VALUES('RC restore fixture','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326)) RETURNING id
      ), property AS (
        INSERT INTO properties(created_by,category_code,address_id,attributes) SELECT actor.id,'apartment',address.id,'{"area":50,"rooms":2}'::jsonb FROM actor,address RETURNING id,created_by
      ), source AS (
        INSERT INTO listing_sources(kind) VALUES('direct') RETURNING id
      ), listing AS (
        INSERT INTO listings(property_id,source_id,seller_id,deal_type,price,title,status,published_at) SELECT property.id,source.id,property.created_by,'sale',10000000,'RC restore fixture','published',now() FROM property,source RETURNING id,seller_id
      )
      INSERT INTO listing_history(listing_id,actor_id,event,after_data) SELECT id,seller_id,'published','{"restore":true}'::jsonb FROM listing
    `),
    );
    await boundedOperation(endFixture, 5000);
    // No API/workers use this generated source. Close its sole writer before backup.
    const privateRoot = resolve('../../.cache/recovery');
    workspace = await createRecoveryWorkspace(privateRoot);
    await admin.query(`CREATE DATABASE "${target}"`);
    targetCreated = true;
    child = spawn(process.execPath, ['scripts/recovery-drill.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: source.toString(),
        RECOVERY_SOURCE_QUIESCED: 'true',
        RECOVERY_PRIVATE_DIRECTORY: workspace.directory,
        RECOVERY_RESTORE_TARGET: target,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    completion = new Promise((resolve, reject) => {
      child.once('error', () =>
        reject(new Error('Recovery fixture tool failed')),
      );
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Recovery fixture failed')),
      );
    });
    await monitor.run(() => boundedOperation(() => completion, 120000));
    evidence = JSON.parse(
      await readFile(
        resolve(workspace.directory, 'recovery-result.json'),
        'utf8',
      ),
    );
  } catch {
    failed = true;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try {
        await boundedOperation(() => completion.catch(() => {}), 3000);
      } catch {
        child.kill('SIGKILL');
        await boundedOperation(() => completion.catch(() => {}), 2000).catch(
          () => {
            failed = true;
          },
        );
      }
    }
    // Parent owns plaintext cleanup even if a signal skipped child finally.
    if (workspace)
      await workspace.remove().catch(() => {
        failed = true;
      });
    await boundedOperation(endFixture, 5000).catch(() => {
      failed = true;
    });
    if (targetCreated)
      await boundedOperation(
        () => admin.query(`DROP DATABASE "${target}" WITH (FORCE)`),
        10000,
      ).catch(() => {
        failed = true;
      });
    if (created)
      await boundedOperation(
        () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`),
        10000,
      ).catch(() => {
        failed = true;
      });
    await boundedOperation(() => admin.end(), 5000).catch(() => {
      failed = true;
    });
  }
  if (failed) throw new Error('Recovery fixture failed');
  return evidence;
}
try {
  await publishRecoveryEvidence(
    resolve('../../.cache/phase4d-recovery.json'),
    run,
  );
  console.log(
    'Encrypted populated fixture restore verified with complete scratch cleanup: domain/history/audit,PostGIS,15 migrations and sequence identity',
  );
} catch {
  console.error(
    'Controlled recovery fixture failed; inspect local cleanup status',
  );
  process.exitCode = 1;
}
