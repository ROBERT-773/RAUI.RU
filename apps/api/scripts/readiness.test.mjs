import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localLoadTarget, percentile } from './load.mjs';
test('Load accepts only explicit loopback read-only targets without credentials/query/fragment', () => {
  assert.equal(
    localLoadTarget('http://127.0.0.1:3101/v1/categories').hostname,
    '127.0.0.1',
  );
  for (const value of [
    'https://raui.ru/v1/categories',
    'http://secret@localhost:3101/health',
    'http://localhost:3101/health?secret=x',
    'http://localhost:3101/v1/auth/login',
    'http://127.0.0.1.nip.io:3101/health',
  ])
    assert.throws(() => localLoadTarget(value));
});
test('Measured percentiles use nearest rank of finite sorted timings', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.throws(() => percentile([], 0.95));
  assert.throws(() => percentile([NaN], 0.95));
});

test('Backup target cannot overwrite source or use a remote database', async () => {
  const { localDatabase, restoreName, objectKey } =
    await import('./recovery.mjs');
  assert.equal(
    localDatabase('postgresql://local@127.0.0.1/raui').hostname,
    '127.0.0.1',
  );
  for (const url of ['postgresql://remote/db', 'https://localhost/db'])
    assert.throws(() => localDatabase(url));
  assert.throws(() => restoreName('raui'));
  assert.throws(() =>
    restoreName('raui_restore_test_' + 'a'.repeat(16) + ';DROP DATABASE raui'),
  );
  assert.equal(
    restoreName('raui_restore_test_' + 'a'.repeat(16)),
    'raui_restore_test_' + 'a'.repeat(16),
  );
  for (const path of [
    '../secret',
    '/secret',
    'a/../../secret',
    'a\\secret',
    'a\u0000b',
  ])
    assert.throws(() => objectKey(path));
  assert.equal(objectKey('media/fixture.bin'), 'media/fixture.bin');
});
test('Authenticated backup encryption rejects corrupt ciphertext and wrong keys', async () => {
  const { seal, open } = await import('./recovery.mjs');
  const key = Buffer.alloc(32, 7),
    other = Buffer.alloc(32, 8);
  const encrypted = seal(Buffer.from('private fixture'), key);
  assert.equal(open(encrypted, key).toString(), 'private fixture');
  assert.throws(() => open(encrypted, other));
  const corrupt = Buffer.from(encrypted);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => open(corrupt, key));
});

test('Release manifest rejects mutable identity, unsafe paths and missing verified gates', async () => {
  const { validateRelease } =
    await import('../../../scripts/release-contract.mjs');
  const good = {
    version: 1,
    sha: 'a'.repeat(40),
    runId: '123',
    migrations: 15,
    riskyDefaults: 'off',
    gates: [
      'lint',
      'typecheck',
      'unit',
      'integration',
      'build',
      'e2e',
      'migrations',
      'smoke',
      'load',
      'security',
      'restore',
      'observability',
    ],
    files: [
      'apps/api/dist/main.js',
      'apps/web/.next/BUILD_ID',
      'apps/api/migrations/001_core.sql',
      'apps/api/migrations/002_search_product.sql',
      'apps/api/migrations/003_commerce.sql',
      'apps/api/migrations/004_commerce_reconciliation.sql',
      'apps/api/migrations/005_professional_integrations.sql',
      'apps/api/migrations/006_professional_workflows.sql',
      'apps/api/migrations/007_partner_clients.sql',
      'apps/api/migrations/008_professional_operations.sql',
      'apps/api/migrations/009_ai_trust_analytics.sql',
      'apps/api/migrations/010_analytics_identity_and_trust_geo.sql',
      'apps/api/migrations/011_ai_reported_cost.sql',
      'apps/api/migrations/012_search_queue_observability.sql',
      'apps/api/migrations/013_region_search.sql',
      'apps/api/migrations/014_user_public_id.sql',
      'apps/api/migrations/015_staff_permissions.sql',
      'pnpm-lock.yaml',
      'package.json',
      'infra/observability/alerts.yml',
      'infra/observability/dashboard.json',
      'infra/observability/prometheus.yml',
      '.cache/phase4d-load.json',
      '.cache/phase4d-recovery.json',
    ].map((path) => ({ path, sha256: 'b'.repeat(64) })),
  };
  assert.doesNotThrow(() => validateRelease(good, 'a'.repeat(40)));
  for (const omitted of good.files)
    assert.throws(
      () =>
        validateRelease(
          {
            ...good,
            files: good.files.filter((file) => file.path !== omitted.path),
          },
          'a'.repeat(40),
        ),
      /Incomplete release artifact/,
      `Omission must fail closed: ${omitted.path}`,
    );
  for (const patch of [
    { sha: 'master' },
    { runId: undefined },
    { runId: '0' },
    { runId: '123x' },
    { migrations: 0 },
    { migrations: 12 },
    { riskyDefaults: 'on' },
    { gates: ['lint'] },
    { files: [{ path: 'apps/api/dist/main.js', sha256: 'b'.repeat(64) }] },
    { files: [{ path: '../.env', sha256: 'b'.repeat(64) }] },
  ])
    assert.throws(() => validateRelease({ ...good, ...patch }, 'a'.repeat(40)));
  assert.throws(() => validateRelease(good, 'c'.repeat(40)));
  assert.throws(() => validateRelease(good, 'a'.repeat(40), '456'));
  assert.doesNotThrow(() => validateRelease(good, 'a'.repeat(40), '123'));
});

test('Recovery cleanup removes private artifacts and wipes keys even when scratch DROP fails', async () => {
  const { cleanupRecovery } = await import('./recovery.mjs');
  const called = [];
  await assert.rejects(
    cleanupRecovery({
      drop: async () => {
        called.push('drop');
        throw new Error('offline');
      },
      end: async () => called.push('end'),
      wipe: () => called.push('wipe'),
      remove: async () => called.push('remove'),
    }),
    /Recovery cleanup incomplete/,
  );
  assert.deepEqual(called, ['drop', 'end', 'wipe', 'remove']);
});

test('Release verification binds measured evidence and rejects tampering', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { verifyFiles } = await import('../../../scripts/release-contract.mjs');
  const root = await mkdtemp(join(tmpdir(), 'raui-release-test-'));
  try {
    await mkdir(join(root, '.cache'));
    const values = {
      '.cache/phase4d-load.json': {
        version: 1,
        results: [
          'catalog',
          'search',
          'public-detail',
          'map',
          'auth-me',
          'auth-sessions',
        ].map((scenario) => ({
          scenario,
          p50Ms: 5,
          p95Ms: 10,
          p99Ms: 15,
          requestsPerSecond: 100,
          successes: 40,
          warmup: 5,
          warmupErrors: 0,
          targetP95Ms: 300,
          errors: 0,
          errorKinds: { transport: 0, status: 0, body: 0, contract: 0 },
          requests: 40,
          concurrency: 4,
        })),
      },
      '.cache/phase4d-recovery.json': {
        version: 1,
        sourceUntouched: true,
        databaseRestore: 'verified',
        objectFixtureRestore: 'verified',
        migrationsVerified: 15,
        tablesVerified: 61,
        cipher: 'AES-256-GCM',
        sourceWritersQuiesced: true,
        sequenceStateAndConfig: 'verified',
        sequencesVerified: 9,
        sequenceNextValuesVerified: 9,
        pristineSequencesVerified: 7,
        calledSequencesVerified: 2,
      },
    };
    const files = [];
    for (const [path, value] of Object.entries(values)) {
      const bytes = JSON.stringify(value);
      await writeFile(join(root, path), bytes);
      files.push({
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    await assert.doesNotReject(verifyFiles({ files }, root));
    const loadPath = '.cache/phase4d-load.json';
    const goodResults = values[loadPath].results;
    const badInventories = [
      goodResults.slice(1),
      [...goodResults.slice(1), goodResults[1]],
      goodResults.map((result, index) =>
        index === 0 ? { ...result, scenario: 'unknown' } : result,
      ),
    ];
    for (const patch of [
      { errors: 1 },
      { errorKinds: undefined },
      { errorKinds: { transport: 40, status: 0, body: 0, contract: 0 } },
      { errorKinds: { transport: -1, status: 1, body: 0, contract: 0 } },
      { errorKinds: { transport: 0.5, status: 0, body: 0, contract: 0 } },
      { errorKinds: { transport: 0, status: 0, body: 0 } },
      { p95Ms: 301 },
      { p50Ms: null },
      { p99Ms: -1 },
      { p50Ms: 11 },
      { requests: 39 },
      { successes: 39 },
      { warmup: 4 },
      { warmupErrors: 1 },
      { concurrency: 5 },
      { targetP95Ms: 301 },
      { requestsPerSecond: 0 },
    ])
      badInventories.push(
        goodResults.map((result, index) =>
          index === 0 ? { ...result, ...patch } : result,
        ),
      );
    for (const results of badInventories) {
      const bytes = JSON.stringify({ ...values[loadPath], results });
      await writeFile(join(root, loadPath), bytes);
      const changed = files.map((file) =>
        file.path === loadPath
          ? {
              ...file,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }
          : file,
      );
      await assert.rejects(
        verifyFiles({ files: changed }, root),
        /Invalid measured load evidence/,
      );
    }
    await writeFile(join(root, loadPath), JSON.stringify(values[loadPath]));
    const recoveryPath = '.cache/phase4d-recovery.json';
    for (const patch of [
      { migrationsVerified: 12 },
      { sequenceStateAndConfig: undefined },
      { sourceWritersQuiesced: false },
      { sequenceNextValuesVerified: 8 },
      { pristineSequencesVerified: 0 },
      { calledSequencesVerified: 0 },
      { calledSequencesVerified: 3 },
      { sequencesVerified: 9.5 },
      { pristineSequencesVerified: -1 },
    ]) {
      const bytes = JSON.stringify({ ...values[recoveryPath], ...patch });
      await writeFile(join(root, recoveryPath), bytes);
      const changed = files.map((file) =>
        file.path === recoveryPath
          ? {
              ...file,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }
          : file,
      );
      await assert.rejects(
        verifyFiles({ files: changed }, root),
        /Invalid restore evidence/,
      );
    }
    await writeFile(
      join(root, recoveryPath),
      JSON.stringify(values[recoveryPath]),
    );
    await writeFile(join(root, '.cache/phase4d-load.json'), '{}');
    await assert.rejects(verifyFiles({ files }, root), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Restored sequence next values preserve pristine, called, descending and cycling identities', async () => {
  const { sequenceNextValue } = await import('./recovery.mjs');
  const state = {
    last_value: '7',
    is_called: false,
    increment_by: '3',
    min_value: '1',
    max_value: '10',
    cycle: false,
  };
  assert.equal(sequenceNextValue(state), '7');
  assert.equal(sequenceNextValue({ ...state, is_called: true }), '10');
  assert.equal(
    sequenceNextValue({
      ...state,
      last_value: '10',
      is_called: true,
      cycle: true,
    }),
    '1',
  );
  assert.equal(
    sequenceNextValue({
      ...state,
      last_value: '1',
      increment_by: '-3',
      is_called: true,
      cycle: true,
    }),
    '10',
  );
  assert.throws(
    () => sequenceNextValue({ ...state, last_value: '10', is_called: true }),
    /exhausted/,
  );
  assert.equal(
    sequenceNextValue({
      ...state,
      last_value: '9007199254740993',
      max_value: '9223372036854775807',
    }),
    '9007199254740993',
  );
});

test('Recovery initialization never prints credential-bearing malformed URLs', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'raui-recovery-init-'));
  const cwd = join(root, 'apps/api');
  await mkdir(cwd, { recursive: true });
  const marker = 'PRIVATE_RECOVERY_STARTUP_MARKER';
  try {
    for (const script of ['recovery-drill.mjs', 'recovery-fixture.mjs']) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL(script, import.meta.url))],
        {
          cwd,
          env: {
            ...process.env,
            DATABASE_URL: `postgresql://fixture:${marker}@[::1`,
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(result.status, 1);
      assert.ok(!(result.stdout + result.stderr).includes(marker));
      assert.match(
        result.stderr,
        /Recovery drill failed|Controlled recovery fixture failed/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A stuck recovery pool close still wipes keys and removes plaintext', async () => {
  const { cleanupRecovery } = await import('./recovery.mjs');
  const { boundedOperation } = await import('./e2e-runtime.mjs');
  const calls = [];
  await assert.rejects(
    cleanupRecovery({
      drop: async () => calls.push('drop'),
      end: () => boundedOperation(() => new Promise(() => {}), 10),
      wipe: () => calls.push('wipe'),
      remove: async () => calls.push('remove'),
    }),
    /Recovery cleanup incomplete/,
  );
  assert.deepEqual(calls, ['drop', 'wipe', 'remove']);
});

test('Parent-owned recovery workspace removes plaintext left by a killed child', async () => {
  const { mkdtemp, readFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createRecoveryWorkspace } = await import('./recovery.mjs');
  const root = await mkdtemp(join(tmpdir(), 'raui-recovery-parent-'));
  const workspace = await createRecoveryWorkspace(root);
  const plaintext = join(workspace.directory, 'authenticated.dump');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],'synthetic private fixture');process.stdout.write('ready');setInterval(()=>{},1000);`,
      plaintext,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    assert.equal(
      await readFile(plaintext, 'utf8'),
      'synthetic private fixture',
    );
    child.kill('SIGKILL');
    await exited;
    await workspace.remove();
    await assert.rejects(access(workspace.directory), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exited;
    await workspace.remove();
    await rm(root, { recursive: true, force: true });
  }
});

test('Recovery success evidence is published only after lifecycle cleanup succeeds', async () => {
  const { mkdtemp, writeFile, readFile, access, rm } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { publishRecoveryEvidence } = await import('./recovery.mjs');
  const root = await mkdtemp(join(tmpdir(), 'raui-recovery-evidence-')),
    output = join(root, 'evidence.json');
  try {
    await writeFile(output, JSON.stringify({ stale: true }));
    await assert.rejects(
      publishRecoveryEvidence(output, async () => {
        throw new Error('Scratch DROP failed');
      }),
      /Scratch DROP failed/,
    );
    await assert.rejects(access(output), { code: 'ENOENT' });
    let cleanupComplete = false;
    await publishRecoveryEvidence(output, async () => {
      cleanupComplete = true;
      return { verified: true };
    });
    assert.equal(cleanupComplete, true);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      verified: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CI provenance rejects same-name workflows and binds successful immutable run identity', async () => {
  const { validateCiRun } =
    await import('../../../scripts/release-contract.mjs');
  const sha = 'a'.repeat(40);
  const run = {
    id: 123,
    head_sha: sha,
    conclusion: 'success',
    status: 'completed',
    name: 'RAUI CI',
    path: '.github/workflows/ci.yml',
  };
  assert.doesNotThrow(() => validateCiRun(run, sha, '123'));
  for (const patch of [
    { path: '.github/workflows/other.yml' },
    { id: 456 },
    { head_sha: 'b'.repeat(40) },
    { conclusion: 'failure' },
    { status: 'in_progress' },
  ])
    assert.throws(() => validateCiRun({ ...run, ...patch }, sha, '123'));
});
