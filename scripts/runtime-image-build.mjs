import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function fail(message) {
  console.error(message);
  process.exit(64);
}
const args = process.argv.slice(2);
let candidate = false;
let cloudNetwork = false;
let site;
let environment = 'staging';
let tag = 'raui-runtime:local';
for (let index = 0; index < args.length; index++) {
  switch (args[index]) {
    case '--cloud-network':
      cloudNetwork = true;
      break;
    case '--candidate':
      candidate = true;
      break;
    case '--site-url':
      site = args[++index];
      break;
    case '--environment':
      environment = args[++index];
      break;
    case '--tag':
      tag = args[++index];
      break;
    default:
      fail('Unknown build argument');
  }
}
try {
  const url = new URL(site);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== site ||
    url.username ||
    url.password
  )
    throw Error();
  if (environment === 'production' && url.protocol !== 'https:') throw Error();
} catch {
  fail('Clean public origin required');
}
if (!['staging', 'production'].includes(environment))
  fail('Invalid deployment environment');
if (!/^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/.test(tag))
  fail('Local image tag required');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) fail('Full source revision required');
const dirty = execFileSync('git', ['status', '--porcelain'], {
  encoding: 'utf8',
}).trim();
if (dirty && !candidate)
  fail(
    'Clean committed source required; --candidate is for uncommitted local acceptance only',
  );
const config = process.env.DOCKER_CONFIG ?? resolve('.cache/runtime-docker');
mkdirSync(config, { recursive: true, mode: 0o700 });
const network = [];
if (cloudNetwork) {
  const proxy = new URL(process.env.HTTP_PROXY ?? '');
  const address = await lookup(proxy.hostname, { family: 4 });
  network.push(
    '--network=host',
    '--add-host',
    `${proxy.hostname}:${address.address}`,
    '--build-arg',
    'HTTP_PROXY',
    '--build-arg',
    'HTTPS_PROXY',
    '--build-arg',
    'NO_PROXY',
  );
  if (process.env.NODE_EXTRA_CA_CERTS)
    network.push(
      '--secret',
      `id=build_ca,src=${process.env.NODE_EXTRA_CA_CERTS}`,
    );
}
let snapshot;
let context = '.';
if (!candidate) {
  snapshot = mkdtempSync(resolve(tmpdir(), 'raui-runtime-source-'));
  const archive = resolve(snapshot, 'source.tar');
  writeFileSync(
    archive,
    execFileSync('git', ['archive', '--format=tar', revision], {
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  execFileSync('tar', ['-xf', archive, '-C', snapshot]);
  rmSync(archive);
  context = snapshot;
}
try {
  const result = spawnSync(
    'docker',
    [
      'build',
      ...network,
      '-f',
      resolve(context, 'infra/runtime/Dockerfile'),
      '--build-arg',
      `SOURCE_REVISION=${revision}`,
      '--build-arg',
      `SOURCE_STATE=${candidate ? 'candidate' : 'committed'}`,
      '--build-arg',
      `SITE_URL=${site}`,
      '--build-arg',
      `DEPLOYMENT_ENV=${environment}`,
      '-t',
      tag,
      context,
    ],
    { stdio: 'inherit', env: { ...process.env, DOCKER_CONFIG: config } },
  );
  if (result.error) fail('Docker build could not start');
  process.exitCode = result.status ?? 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
