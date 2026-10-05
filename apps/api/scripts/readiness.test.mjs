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
    migrations: 11,
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
    { migrations: 0 },
    { riskyDefaults: 'on' },
    { gates: ['lint'] },
    { files: [{ path: 'apps/api/dist/main.js', sha256: 'b'.repeat(64) }] },
    { files: [{ path: '../.env', sha256: 'b'.repeat(64) }] },
  ])
    assert.throws(() => validateRelease({ ...good, ...patch }, 'a'.repeat(40)));
  assert.throws(() => validateRelease(good, 'c'.repeat(40)));
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
        results: ['catalog', 'search', 'public-detail'].map((scenario) => ({
          scenario,
          p95Ms: 10,
          errors: 0,
          requests: 40,
          concurrency: 4,
        })),
      },
      '.cache/phase4d-recovery.json': {
        version: 1,
        sourceUntouched: true,
        databaseRestore: 'verified',
        objectFixtureRestore: 'verified',
        migrationsVerified: 11,
        tablesVerified: 61,
        cipher: 'AES-256-GCM',
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
    await writeFile(join(root, '.cache/phase4d-load.json'), '{}');
    await assert.rejects(verifyFiles({ files }, root), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
