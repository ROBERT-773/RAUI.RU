import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readdir,
  readFile,
  writeFile,
  lstat,
  realpath,
} from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
const gates = [
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
];
function releasePath(path) {
  return (
    typeof path === 'string' &&
    /^(apps\/api\/(dist|migrations)\/|apps\/web\/\.next\/|infra\/observability\/|pnpm-lock\.yaml$|package\.json$|\.cache\/phase4d-(load|recovery)\.json$)/.test(
      path,
    ) &&
    !path.split('/').some((part) => part === '..' || part === '.' || !part) &&
    !path.includes('\\') &&
    !path.includes('\u0000') &&
    !path.endsWith('.env')
  );
}
export function validateRelease(manifest, expectedSha) {
  if (
    !manifest ||
    manifest.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(expectedSha) ||
    manifest.sha !== expectedSha ||
    manifest.migrations !== 11 ||
    manifest.riskyDefaults !== 'off' ||
    !Array.isArray(manifest.gates) ||
    gates.some((gate) => !manifest.gates.includes(gate)) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 20000
  )
    throw new Error(
      'Invalid release identity, migration/flag compatibility or quality gates',
    );
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !releasePath(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      seen.has(file.path)
    )
      throw new Error('Invalid release artifact path/hash');
    seen.add(file.path);
  }
  for (const path of [
    'apps/api/dist/main.js',
    'apps/web/.next/BUILD_ID',
    'apps/api/migrations/001_core.sql',
    'apps/api/migrations/011_ai_reported_cost.sql',
    'pnpm-lock.yaml',
    '.cache/phase4d-load.json',
    '.cache/phase4d-recovery.json',
  ])
    if (!seen.has(path)) throw new Error('Incomplete release artifact');
}
async function hashFiles(root, path, files) {
  if (path.startsWith('apps/web/.next/cache')) return;
  const absolute = resolve(root, path),
    info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error('Artifact symlink rejected');
  if (info.isDirectory()) {
    for (const child of (await readdir(absolute)).sort())
      await hashFiles(root, path + '/' + child, files);
  } else if (
    info.isFile() &&
    releasePath(path) &&
    !path.startsWith('apps/web/.next/cache/')
  ) {
    files.push({
      path: relative(root, absolute),
      sha256: createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex'),
    });
  }
}
export async function verifyFiles(manifest, root) {
  for (const file of manifest.files) {
    const absolute = resolve(root, file.path);
    const resolved = await realpath(absolute);
    if (!resolved.startsWith((await realpath(root)) + '/'))
      throw new Error('Artifact symlink traversal rejected');
    if (
      (await lstat(absolute)).isSymbolicLink() ||
      createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex') !== file.sha256
    )
      throw new Error('Release artifact checksum mismatch');
  }
  const load = JSON.parse(
    await readFile(resolve(root, '.cache/phase4d-load.json'), 'utf8'),
  );
  const recovery = JSON.parse(
    await readFile(resolve(root, '.cache/phase4d-recovery.json'), 'utf8'),
  );
  if (
    load.version !== 1 ||
    !Array.isArray(load.results) ||
    load.results.length !== 3 ||
    load.results.some(
      (result) =>
        !['catalog', 'search', 'public-detail'].includes(result.scenario) ||
        !Number.isFinite(result.p95Ms) ||
        result.p95Ms < 0 ||
        result.p95Ms > 300 ||
        result.errors !== 0 ||
        result.requests !== 40 ||
        result.concurrency !== 4,
    ) ||
    new Set(load.results.map((result) => result.scenario)).size !== 3
  )
    throw new Error('Invalid measured load evidence');
  if (
    recovery.version !== 1 ||
    recovery.sourceUntouched !== true ||
    recovery.databaseRestore !== 'verified' ||
    recovery.objectFixtureRestore !== 'verified' ||
    recovery.migrationsVerified !== 11 ||
    !Number.isInteger(recovery.tablesVerified) ||
    recovery.tablesVerified < 1 ||
    recovery.cipher !== 'AES-256-GCM'
  )
    throw new Error('Invalid restore evidence');
}
async function main() {
  const [mode, manifestPath, expectedSha] = process.argv.slice(2);
  if (
    !['create', 'verify'].includes(mode) ||
    !manifestPath ||
    !/^[a-f0-9]{40}$/.test(expectedSha ?? '')
  )
    throw new Error('Use create/verify manifest-path immutable-sha');
  if (mode === 'create') {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim() !== expectedSha ||
      !process.env.GITHUB_RUN_ID
    )
      throw new Error(
        'Release creation requires successful CI provenance; local dry-run verifies downloaded artifacts',
      );
    const files = [];
    for (const path of [
      'apps/api/dist',
      'apps/api/migrations',
      'apps/web/.next',
      'infra/observability',
      'pnpm-lock.yaml',
      '.cache/phase4d-load.json',
      '.cache/phase4d-recovery.json',
      'package.json',
    ])
      await hashFiles(process.cwd(), path, files);
    const manifest = {
      version: 1,
      sha: expectedSha,
      migrations: 11,
      riskyDefaults: 'off',
      gates,
      runId: process.env.GITHUB_RUN_ID,
      files,
    };
    validateRelease(manifest, expectedSha);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateRelease(manifest, expectedSha);
    await verifyFiles(manifest, process.cwd());
    console.log(
      'Release/rollback artifact identity, hashes, gates and migration/flag contract verified; no deployment',
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
