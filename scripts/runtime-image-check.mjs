import assert from 'node:assert/strict';
import { readdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyMigrationPackage } from './runtime-image-verification.mjs';

assert.equal(process.getuid(), 1000, 'Runtime must use the non-root node UID');
assert.equal(process.versions.node, '24.19.0');
execFileSync('python3', [
  '-c',
  'import sys; assert sys.version_info >= (3, 12)',
]);
const root = resolve(process.env.RAUI_RUNTIME_ROOT ?? '/app');
for (const file of [
  'main',
  'worker',
  'search-worker',
  'commerce-worker',
  'professional-worker',
  'trust-worker',
  'modules/database/migrate',
]) {
  await access(resolve(root, 'apps/api/dist', `${file}.js`));
}
for (const file of [
  'apps/web/.next/BUILD_ID',
  'apps/web/.next/server/app/robots.txt.body',
  'apps/web/next.config.ts',
  'apps/ai/raui_ai/worker.py',
]) {
  await access(resolve(root, file));
}
const api = createRequire(resolve(root, 'apps/api/package.json'));
const web = createRequire(resolve(root, 'apps/web/package.json'));
assert.equal(
  typeof (await import(api.resolve('@raui/config/ingress'))).normalizeIp,
  'function',
);
const sharp = api('sharp');
const png = await sharp({
  create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
})
  .png()
  .toBuffer();
assert.equal((await sharp(png).metadata()).width, 2);
for (const name of ['next', 'react', 'react-dom']) web(name);
assert.ok(await readdir(resolve(root, 'apps/web/.next/static')));
await verifyMigrationPackage(root);
process.chdir(resolve(root, 'apps/api'));
api('reflect-metadata');
const { PythonDuplicateScorer } = api('./dist/modules/trust/worker.js');
const result = await new PythonDuplicateScorer().score({
  schemaVersion: 1,
  subject: {},
  candidates: [],
});
assert.deepEqual(result, { schemaVersion: 1, candidates: [] });
console.log(
  'Runtime image contract passed: non-root, Node/Python, assets, natives, workspace, SQL checksums, actual trust scorer',
);
