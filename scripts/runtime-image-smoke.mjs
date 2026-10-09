import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  assertLocalPortsFree,
  cleanupRuntimeResources,
} from './runtime-image-verification.mjs';

// Orchestrator uses host tooling; every service/worker and the copied fixture
// execute the image's code and dependencies, with no source/dependency mounts.
const require = createRequire(resolve('apps/api/package.json'));
const { Pool } = require('pg');
const image = process.argv[2];
assert.match(
  image ?? '',
  /^sha256:[a-f0-9]{64}$/,
  'Pass an immutable local image ID',
);
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));
assert.ok(
  ['127.0.0.1', 'localhost'].includes(
    new URL(process.env.REDIS_URL ?? '').hostname,
  ),
);
assert.ok(
  ['127.0.0.1', 'localhost'].includes(
    new URL(process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:9200').hostname,
  ),
);
await assertLocalPortsFree([3000, 3001]);
const name = `raui_runtime_${randomBytes(6).toString('hex')}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'raui-image-smoke-'));
const privateDir = resolve(temporary, 'private');
const envFile = resolve(temporary, 'runtime.env');
const admin = new Pool({ connectionString: database.toString() });
const containers = [];
let created = false;
let privateCreated = false;
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 90000 });
const target = new URL(database);
target.pathname = `/${name}`;
const env = {
  NODE_ENV: 'development',
  DEPLOYMENT_ENV: 'staging',
  SITE_URL: 'http://127.0.0.1:3000',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  API_INTERNAL_URL: 'http://127.0.0.1:3001',
  API_PORT: '3001',
  PORT: '3000',
  DATABASE_URL: target.toString(),
  REDIS_URL: process.env.REDIS_URL,
  OPENSEARCH_URL: process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:9200',
  OPENSEARCH_ALIAS: name.replaceAll('_', '-'),
  STORAGE_DRIVER: 'local',
  LOCAL_PRIVATE_DIR: '/runtime-private',
  AI_ENABLED: 'false',
};
const flags = [
  '--network=host',
  '--env-file',
  envFile,
  '--mount',
  `type=bind,src=${privateDir},dst=/runtime-private`,
];
// Only this task-owned bind mount changes ownership; service processes remain UID 1000.
function privateMountOwner(uid, gid) {
  assert.ok(Number.isSafeInteger(uid) && uid >= 0);
  assert.ok(Number.isSafeInteger(gid) && gid >= 0);
  docker(
    'run',
    '--rm',
    '--network=none',
    '--user',
    '0',
    '--entrypoint',
    'chown',
    '--mount',
    `type=bind,src=${privateDir},dst=/runtime-private`,
    image,
    '-R',
    `${uid}:${gid}`,
    '/runtime-private',
  );
}
function ownedListener(container, port) {
  assert.equal(
    docker('inspect', '--format', '{{.State.Running}}', container).trim(),
    'true',
    'Owned runtime container exited',
  );
  const code = `import('/app/scripts/runtime-image-verification.mjs').then(m=>{if(!m.ownsListeningPort(${port}))process.exit(1)})`;
  docker('exec', container, 'node', '-e', code);
}
async function waitHealth(url, container, port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(
      docker('inspect', '--format', '{{.State.Running}}', container).trim(),
      'true',
      'Owned runtime container exited',
    );
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) {
        ownedListener(container, port);
        return;
      }
    } catch {
      /* Retry readiness while the owned process is alive. */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw Error('Runtime health/ownership deadline');
}
let failure;

try {
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(privateDir, { mode: 0o700 }),
  );
  privateCreated = true;
  privateMountOwner(1000, 1000);
  await writeFile(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const db = new Pool({ connectionString: target.toString() });
  try {
    docker('run', '--rm', ...flags, image, 'migrate');
    const firstLedger = (
      await db.query(
        'SELECT name,checksum,applied_at::text FROM schema_migrations ORDER BY name',
      )
    ).rows;
    docker('run', '--rm', ...flags, image, 'migrate');
    assert.deepEqual(
      (
        await db.query(
          'SELECT name,checksum,applied_at::text FROM schema_migrations ORDER BY name',
        )
      ).rows,
      firstLedger,
    );

    assert.equal(
      (await db.query('SELECT count(*)::int AS count FROM schema_migrations'))
        .rows[0].count,
      17,
    );
    docker(
      'run',
      '--rm',
      '--network=none',
      '--entrypoint',
      'node',
      image,
      'scripts/runtime-image-check.mjs',
    );
    for (const role of ['api', 'web', 'media']) {
      const container = `${name}-${role}`;
      containers.push(container);
      docker('run', '-d', '--name', container, ...flags, image, role);
    }
    await waitHealth('http://127.0.0.1:3001/health/ready', `${name}-api`, 3001);
    await waitHealth('http://127.0.0.1:3000/health', `${name}-web`, 3000);
    const smoke = spawnSync(process.execPath, ['scripts/smoke.mjs'], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        SMOKE_API_URL: 'http://127.0.0.1:3001',
        SMOKE_WEB_URL: 'http://127.0.0.1:3000',
      },
    });
    assert.equal(smoke.status, 0, smoke.stderr);
    docker(
      'cp',
      'apps/api/scripts/core-smoke.mjs',
      `${name}-api:/app/apps/api/runtime-core-smoke.mjs`,
    );
    docker(
      'exec',
      '--workdir',
      '/app/apps/api',
      `${name}-api`,
      'node',
      'runtime-core-smoke.mjs',
    );
    assert.ok(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM media_jobs WHERE state='done'",
        )
      ).rows[0].count > 0,
    );
    // Local durable fixtures, with outbound providers deliberately absent.
    await db.query(
      "INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key) SELECT id,'email','runtime-fixture','runtime-fixture' FROM users LIMIT 1",
    );
    await db.query(
      "UPDATE moderation_cases SET state='pending' WHERE listing_id=(SELECT id FROM listings LIMIT 1)",
    );
    await db.query(
      "INSERT INTO commerce_promotion_products(code,kind,version,price_minor,currency,duration_hours,priority) VALUES('runtime-fixture','standard',1,0,'RUB',1,1)",
    );
    await db.query(
      "INSERT INTO commerce_promotion_activations(account_id,listing_id,promotion_product_id,starts_at,ends_at,status) SELECT l.seller_id,l.id,p.id,now()-interval '2 hours',now()-interval '1 hour','active' FROM listings l CROSS JOIN commerce_promotion_products p WHERE p.code='runtime-fixture' LIMIT 1",
    );
    for (const role of ['search', 'commerce', 'professional', 'trust'])
      docker('run', '--rm', ...flags, image, role, '--once');
    assert.ok(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM commerce_promotion_activations WHERE status='expired'",
        )
      ).rows[0].count > 0,
    );
    assert.ok(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM notification_deliveries WHERE status IN ('skipped','deferred')",
        )
      ).rows[0].count > 0,
    );
    assert.ok(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM trust_jobs WHERE state='done'",
        )
      ).rows[0].count > 0,
    );
    docker('stop', '--time', '10', `${name}-media`);
    assert.equal(
      docker(
        'inspect',
        '--format',
        '{{.State.ExitCode}}',
        `${name}-media`,
      ).trim(),
      '0',
    );
  } finally {
    await db.end();
  }
} catch (error) {
  failure = error;
} finally {
  const actions = containers.reverse().map((container) => [
    `container ${container}`,
    async () => {
      const state = spawnSync('docker', ['inspect', container], {
        encoding: 'utf8',
      });
      if (state.status === 0) docker('rm', '-f', container);
      else if (!/No such (object|container)/.test(state.stderr))
        throw Error('Owned container inspection failed');
    },
  ]);
  actions.push([
    'search indexes',
    async () => {
      const response = await fetch(
        `${env.OPENSEARCH_URL}/${env.OPENSEARCH_ALIAS}*`,
        { method: 'DELETE', signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok && response.status !== 404)
        throw Error('Search cleanup failed');
    },
  ]);
  if (created)
    actions.push([
      'database',
      async () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`),
    ]);
  actions.push(['admin connection', async () => admin.end()]);
  if (privateCreated)
    actions.push([
      'private mount ownership',
      async () => privateMountOwner(process.getuid(), process.getgid()),
    ]);
  actions.push([
    'private scratch',
    async () => rm(temporary, { recursive: true, force: true }),
  ]);
  try {
    await cleanupRuntimeResources(actions);
  } catch (cleanupError) {
    if (failure) console.error('Runtime fixture failed before cleanup');
    failure = cleanupError;
  }
}
if (failure) throw failure;
console.log(
  'Image smoke passed and owned resources removed: repeated migrations, API/web/core media fixture, search/commerce/professional/trust fixtures and media SIGTERM',
);
