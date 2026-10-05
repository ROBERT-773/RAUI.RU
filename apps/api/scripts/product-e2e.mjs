import { measureLoad } from './load.mjs';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrate } from '../dist/modules/database/migrate.js';
import { passwordHash } from '../dist/common/security.js';
import { SearchIndex } from '../dist/modules/search/index.js';
import { documentOf } from '../dist/modules/search/search.js';
const source = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(source.hostname) ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('E2E requires local DB');
const name = 'raui_test_' + randomBytes(8).toString('hex'),
  admin = new Pool({ connectionString: source.toString() });
await admin.query(`CREATE DATABASE "${name}"`);
source.pathname = '/' + name;
const pool = new Pool({ connectionString: source.toString() });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: source.toString(),
  OPENSEARCH_ALIAS: name.replaceAll('_', '-'),
  API_PORT: '3101',
  WEB_ORIGIN: 'http://127.0.0.1:3100',
  API_INTERNAL_URL: 'http://127.0.0.1:3101',
  SITE_URL: 'http://127.0.0.1:3100',
  E2E_BASE_URL: 'http://127.0.0.1:3100',
};
process.env.OPENSEARCH_ALIAS = env.OPENSEARCH_ALIAS;
const index = new SearchIndex(),
  children = [];
const directory = resolve('../../.cache');
await mkdir(directory, { recursive: true });
let stage = 'fixtures';
function start(args, cwd, label) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(resolve(directory, label + '.log'));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  return child;
}
try {
  await migrate(pool);
  const seller = randomUUID(),
    buyer = randomUUID();
  for (const [id, email, role] of [
    [seller, 'seller@e2e.test', 'owner'],
    [buyer, 'buyer@e2e.test', 'buyer'],
  ])
    await pool.query(
      'INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,$3,$4,$5,now(),now())',
      [
        id,
        email,
        await passwordHash('E2E-only-password-42!'),
        'Тестовый пользователь',
        role,
      ],
    );
  for (const [price, lon, lat, rooms] of [
    [10000000, 37.61, 55.75, 2],
    [20000000, 37.7, 55.8, 3],
  ]) {
    const id = randomUUID(),
      address = randomUUID(),
      property = randomUUID(),
      listingSource = randomUUID();
    await pool.query(
      "INSERT INTO addresses(id,formatted,locality,district,point) VALUES($1,'Москва, Тверская','Москва','Центр',ST_SetSRID(ST_MakePoint($2,$3),4326))",
      [address, lon, lat],
    );
    await pool.query(
      "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,$4)",
      [property, seller, address, { area: 50, rooms, elevator: true }],
    );
    await pool.query(
      "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
      [listingSource],
    );
    await pool.query(
      "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,price,title,status,published_at) VALUES($1,$2,$3,$4,'sale',$5,$6,'published',now())",
      [
        id,
        property,
        listingSource,
        seller,
        price,
        'Квартира ' + rooms + ' комнаты',
      ],
    );
  }
  await index.initialize();
  const rows = (await pool.query('SELECT * FROM public_search_listings')).rows;
  for (const row of rows) await index.write(row.id, '1', documentOf(row));
  await index.request('/' + index.alias + '/_refresh', 'POST');
  start(['dist/main.js'], process.cwd(), 'e2e-api');
  start(
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--port',
      '3100',
      '--hostname',
      '127.0.0.1',
    ],
    resolve('../web'),
    'e2e-web',
  );
  stage = 'service-readiness';
  for (const url of [
    'http://127.0.0.1:3101/health',
    'http://127.0.0.1:3100/health',
  ]) {
    let ready = false;
    for (let n = 0; n < 60; n++) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {
        /* startup */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error('E2E service readiness failed');
  }
  stage = 'load';
  await measureLoad(
    'http://127.0.0.1:3101',
    rows[0].id,
    resolve(directory, 'phase4d-load.json'),
  );
  stage = 'browser-regression';
  const child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test'],
    { cwd: resolve('../web'), env, stdio: 'inherit' },
  );
  process.exitCode = await new Promise((r, j) => {
    child.once('error', j);
    child.once('exit', (c) => r(c ?? 1));
  });
} catch (error) {
  // Report only the bounded stage identifier, never provider/DB errors or URLs.
  if (process.env.GITHUB_ACTIONS === 'true')
    console.error(`::error title=E2E preflight::Failed stage: ${stage}`);
  throw error;
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(
    children.map((child) =>
      child.exitCode === null
        ? new Promise((r) => child.once('exit', r))
        : Promise.resolve(),
    ),
  );
  try {
    await index.request('/' + index.alias + '-*', 'DELETE');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}
