import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const entrypoint = resolve('infra/runtime/entrypoint.sh');
test('dispatcher rejects unknown roles before starting any executable', () => {
  const result = spawnSync('sh', [entrypoint, 'shell', 'echo', 'unsafe']);
  assert.equal(result.status, 64);
  assert.match(result.stderr.toString(), /Unknown runtime role/);
});
test('dispatcher rejects additional arguments for API and web', () => {
  for (const role of ['api', 'web', 'migrate']) {
    const result = spawnSync('sh', [entrypoint, role, '--eval=unsafe']);
    assert.equal(result.status, 64);
    assert.match(result.stderr.toString(), /Unexpected runtime arguments/);
  }
});
test('worker dispatch preserves arguments and executable exit status', () => {
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-'));
  try {
    mkdirSync(join(root, 'apps/api'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'site-origin'), 'http://127.0.0.1:3000\n');
    writeFileSync(join(root, 'deployment-env'), 'staging\n');
    writeFileSync(
      join(root, 'bin/node'),
      '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\nexit 17\n',
      { mode: 0o755 },
    );
    for (const [role, file] of [
      ['media', 'worker'],
      ['search', 'search-worker'],
      ['commerce', 'commerce-worker'],
      ['professional', 'professional-worker'],
      ['trust', 'trust-worker'],
    ]) {
      const result = spawnSync(
        'sh',
        [entrypoint, role, ...(role === 'media' ? [] : ['--once'])],
        {
          env: {
            ...process.env,
            RAUI_RUNTIME_ROOT: root,
            SITE_URL: 'http://127.0.0.1:3000',
            DEPLOYMENT_ENV: 'staging',
            PATH: `${root}/bin:${process.env.PATH}`,
          },
        },
      );
      assert.equal(result.status, 17);
      assert.equal(
        result.stdout.toString(),
        `${root}/apps/api\ndist/${file}.js\n${role === 'media' ? '' : '--once\n'}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build rejects dirty source before invoking Docker', () => {
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-git-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'source.txt'), 'committed');
    execFileSync('git', ['-C', root, 'add', 'source.txt']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Runtime fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    writeFileSync(join(root, 'source.txt'), 'dirty');
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/runtime-image-build.mjs'),
        '--site-url',
        'http://127.0.0.1:3000',
      ],
      { cwd: root },
    );
    assert.equal(result.status, 64);
    assert.match(result.stderr.toString(), /Clean committed source required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('build rejects credentialed and path-bearing public origins', () => {
  for (const origin of [
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?q=1',
  ]) {
    const result = spawnSync(process.execPath, [
      'scripts/runtime-image-build.mjs',
      '--candidate',
      '--site-url',
      origin,
    ]);
    assert.equal(result.status, 64);
    assert.match(result.stderr.toString(), /Clean public origin required/);
  }
});

test('dispatcher rejects an origin that differs from baked web assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-origin-'));
  try {
    writeFileSync(join(root, 'site-origin'), 'http://127.0.0.1:3000\n');
    writeFileSync(join(root, 'deployment-env'), 'staging\n');
    const result = spawnSync('sh', [entrypoint, 'api'], {
      env: {
        ...process.env,
        RAUI_RUNTIME_ROOT: root,
        SITE_URL: 'https://different.example',
        DEPLOYMENT_ENV: 'staging',
      },
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr.toString(), /must match the built artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean build uses committed archive and excludes ignored local input', () => {
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-archive-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'infra/runtime'), { recursive: true });
    writeFileSync(join(root, 'source.txt'), 'committed');
    writeFileSync(join(root, '.gitignore'), '.env\nbin/\n');
    writeFileSync(join(root, 'infra/runtime/Dockerfile'), 'FROM scratch\n');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Runtime fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    writeFileSync(join(root, '.env'), 'ignored local secret');
    writeFileSync(
      join(root, 'bin/docker'),
      '#!/bin/sh\nfor context do :; done\nprintf dirty > "$WORKING_SOURCE"\ntest ! -e "$context/.env" || exit 2\ncat "$context/source.txt"\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/runtime-image-build.mjs'),
        '--site-url',
        'http://127.0.0.1:3000',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DOCKER_CONFIG: join(root, 'bin/config'),
          WORKING_SOURCE: join(root, 'source.txt'),
          PATH: `${root}/bin:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'committed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration package rejects jointly truncated manifest and SQL directory', async () => {
  const helper = resolve('scripts/runtime-image-verification.mjs');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(helper), 'Runtime package verification missing');
  const { verifyMigrationPackage } = await import(helper);
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-sql-'));
  try {
    mkdirSync(join(root, 'apps/api/migrations'), { recursive: true });
    writeFileSync(join(root, 'apps/api/migrations/001_core.sql'), 'SELECT 1;');
    writeFileSync(
      join(root, 'migration-sha256.txt'),
      '0'.repeat(64) + '  apps/api/migrations/001_core.sql\n',
    );
    await assert.rejects(
      verifyMigrationPackage(root),
      /Complete migration SQL package required/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('smoke preflight rejects a real pre-existing local listener', async () => {
  const { createServer } = await import('node:net');
  const helper = resolve('scripts/runtime-image-verification.mjs');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(helper), 'Runtime package verification missing');
  const { assertLocalPortsFree } = await import(helper);
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    await assert.rejects(
      assertLocalPortsFree([server.address().port]),
      /Local runtime ports unavailable/,
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});
test('cleanup removes scratch even when database cleanup fails', async () => {
  const helper = resolve('scripts/runtime-image-verification.mjs');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(helper), 'Runtime package verification missing');
  const { cleanupRuntimeResources } = await import(helper);
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-cleanup-'));
  writeFileSync(join(root, 'runtime.env'), 'synthetic test input');
  try {
    await assert.rejects(
      cleanupRuntimeResources([
        [
          'database',
          async () => {
            throw Error('synthetic DB failure');
          },
        ],
        ['scratch', async () => rmSync(root, { recursive: true, force: true })],
      ]),
      /Runtime cleanup failed: database/,
    );
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('socket ownership matches the listening process and rejects its parent', async () => {
  const { createServer } = await import('node:net');
  const { ownsListeningPort } =
    await import('./runtime-image-verification.mjs');
  assert.equal(
    typeof ownsListeningPort,
    'function',
    'Owned socket verification missing',
  );
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    assert.equal(ownsListeningPort(server.address().port, process.pid), true);
    assert.equal(ownsListeningPort(server.address().port, process.ppid), false);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('migration manifest rejects truncation, duplicates and changed SQL with the full directory present', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync, readdirSync } = await import('node:fs');
  const { verifyMigrationPackage } =
    await import('./runtime-image-verification.mjs');
  const root = mkdtempSync(join(tmpdir(), 'raui-runtime-manifest-'));
  const directory = join(root, 'apps/api/migrations');
  mkdirSync(directory, { recursive: true });
  try {
    const rows = readdirSync('apps/api/migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => {
        const content = readFileSync(join('apps/api/migrations', name));
        writeFileSync(join(directory, name), content);
        return `${createHash('sha256').update(content).digest('hex')}  apps/api/migrations/${name}`;
      });
    const manifest = join(root, 'migration-sha256.txt');
    writeFileSync(manifest, rows.join('\n') + '\n');
    await verifyMigrationPackage(root);
    writeFileSync(manifest, rows.slice(0, -1).join('\n') + '\n');
    await assert.rejects(verifyMigrationPackage(root), /Complete nonduplicate/);
    writeFileSync(manifest, [...rows, rows[0]].join('\n') + '\n');
    await assert.rejects(verifyMigrationPackage(root), /Complete nonduplicate/);
    writeFileSync(manifest, rows.join('\n') + '\n');
    writeFileSync(join(directory, '001_core.sql'), 'changed fixture');
    await assert.rejects(
      verifyMigrationPackage(root),
      /Migration checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
