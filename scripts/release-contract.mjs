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
  'observability',
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
export function validateCiRun(run, expectedSha, expectedRunId) {
  if (
    !/^[1-9][0-9]*$/.test(expectedRunId ?? '') ||
    !/^[a-f0-9]{40}$/.test(expectedSha ?? '') ||
    String(run?.id) !== expectedRunId ||
    run.head_sha !== expectedSha ||
    run.conclusion !== 'success' ||
    run.status !== 'completed' ||
    run.path !== '.github/workflows/ci.yml'
  )
    throw new Error('Invalid successful CI workflow provenance');
}
export function validateRelease(manifest, expectedSha, expectedRunId) {
  if (
    !manifest ||
    manifest.version !== 1 ||
    typeof manifest.runId !== 'string' ||
    !/^[1-9][0-9]*$/.test(manifest.runId) ||
    (expectedRunId !== undefined && manifest.runId !== expectedRunId) ||
    !/^[a-f0-9]{40}$/.test(expectedSha) ||
    manifest.sha !== expectedSha ||
    manifest.migrations !== 16 ||
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
    'apps/api/migrations/016_registration_approval.sql',
    'pnpm-lock.yaml',
    'package.json',
    'infra/observability/alerts.yml',
    'infra/observability/dashboard.json',
    'infra/observability/prometheus.yml',
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
    load.results.length !== 6 ||
    load.results.some(
      (result) =>
        ![
          'catalog',
          'search',
          'public-detail',
          'map',
          'auth-me',
          'auth-sessions',
        ].includes(result.scenario) ||
        !Number.isFinite(result.p50Ms) ||
        !Number.isFinite(result.p99Ms) ||
        result.p50Ms < 0 ||
        result.p50Ms > result.p95Ms ||
        result.p95Ms > result.p99Ms ||
        !Number.isFinite(result.requestsPerSecond) ||
        result.requestsPerSecond <= 0 ||
        result.successes !== 40 ||
        result.warmup !== 5 ||
        result.warmupErrors !== 0 ||
        result.targetP95Ms !== 300 ||
        !Number.isFinite(result.p95Ms) ||
        result.p95Ms < 0 ||
        result.p95Ms > 300 ||
        result.errors !== 0 ||
        !result.errorKinds ||
        Object.keys(result.errorKinds).length !== 4 ||
        ['transport', 'status', 'body', 'contract'].some(
          (kind) =>
            !Number.isSafeInteger(result.errorKinds[kind]) ||
            result.errorKinds[kind] < 0,
        ) ||
        Object.values(result.errorKinds).reduce(
          (sum, count) => sum + count,
          0,
        ) !== result.errors ||
        result.requests !== 40 ||
        result.concurrency !== 4,
    ) ||
    new Set(load.results.map((result) => result.scenario)).size !== 6
  )
    throw new Error('Invalid measured load evidence');
  if (
    recovery.version !== 1 ||
    recovery.sourceUntouched !== true ||
    recovery.databaseRestore !== 'verified' ||
    recovery.objectFixtureRestore !== 'verified' ||
    recovery.migrationsVerified !== 16 ||
    !Number.isInteger(recovery.tablesVerified) ||
    recovery.tablesVerified < 1 ||
    recovery.cipher !== 'AES-256-GCM' ||
    recovery.sourceWritersQuiesced !== true ||
    recovery.sequenceStateAndConfig !== 'verified' ||
    !Number.isSafeInteger(recovery.sequencesVerified) ||
    recovery.sequencesVerified < 1 ||
    recovery.sequenceNextValuesVerified !== recovery.sequencesVerified ||
    !Number.isSafeInteger(recovery.pristineSequencesVerified) ||
    recovery.pristineSequencesVerified < 1 ||
    !Number.isSafeInteger(recovery.calledSequencesVerified) ||
    recovery.calledSequencesVerified < 1 ||
    recovery.pristineSequencesVerified + recovery.calledSequencesVerified !==
      recovery.sequencesVerified
  )
    throw new Error('Invalid restore evidence');
}
async function main() {
  const [mode, manifestPath, expectedSha, expectedRunId] =
    process.argv.slice(2);
  if (mode === 'provenance') {
    validateCiRun(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      expectedSha,
      expectedRunId,
    );
    console.log('Successful CI workflow identity, commit and run verified');
    return;
  }
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
      migrations: 16,
      riskyDefaults: 'off',
      gates,
      runId: process.env.GITHUB_RUN_ID,
      files,
    };
    validateRelease(manifest, expectedSha);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateRelease(manifest, expectedSha, expectedRunId);
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
