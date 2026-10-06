import { measureLoad, readLoadJson } from './load.mjs';
import { Pool } from 'pg';
import { createLoopbackLoadClients } from './load-transport.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import {
  trackProcess,
  waitService,
  terminate,
  boundedOperation,
  watchPoolErrors,
  summarizeLoadSpans,
} from './e2e-runtime.mjs';
import { resolve } from 'node:path';
let stage = 'initialization';
async function run() {
  const source = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['localhost', '127.0.0.1'].includes(source.hostname) ||
    process.env.NODE_ENV === 'production'
  )
    throw new Error('E2E requires local DB');
  const [{ migrate }, { passwordHash }, { SearchIndex }, { documentOf }] =
    await Promise.all([
      import('../dist/modules/database/migrate.js'),
      import('../dist/common/security.js'),
      import('../dist/modules/search/index.js'),
      import('../dist/modules/search/search.js'),
    ]);
  let failed = false;
  let cleanupFailed = false;
  const name = 'raui_test_' + randomBytes(8).toString('hex'),
    admin = new Pool({
      connectionString: source.toString(),
      connectionTimeoutMillis: 3000,
      statement_timeout: 30000,
      query_timeout: 35000,
    });
  source.pathname = '/' + name;
  const pool = new Pool({
    connectionString: source.toString(),
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  const monitor = watchPoolErrors([admin, pool], () => {
    failed = true;
  });
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
  stage = 'fixtures';
  let databaseCreated = false;
  const started = Date.now();
  function start(args, cwd, label) {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = trackProcess(child, label.replace('e2e-', ''));
    const log = createWriteStream(resolve(directory, label + '.log'));
    record.logCompletion = new Promise((resolve) => {
      log.once('finish', resolve);
      log.once('error', () => {
        record.logFailed = true;
        resolve();
      });
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('close', () => log.end());
    children.push(record);
    return child;
  }
  try {
    await mkdir(directory, { recursive: true });
    // Resource allocation must settle before cleanup can decide ownership.
    // An idle error is sticky but cannot race successful CREATE registration.
    await admin.query(`CREATE DATABASE "${name}"`);
    databaseCreated = true;
    await monitor.run(() => migrate(pool));
    const seller = randomUUID(),
      buyer = randomUUID();
    for (const [id, email, role] of [
      [seller, 'seller@e2e.test', 'owner'],
      [buyer, 'buyer@e2e.test', 'buyer'],
      [randomUUID(), 'outsider@e2e.test', 'buyer'],
    ])
      await monitor.run(async () =>
        pool.query(
          'INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,$3,$4,$5,now(),now())',
          [
            id,
            email,
            await passwordHash('E2E-only-password-42!'),
            'Тестовый пользователь',
            role,
          ],
        ),
      );
    for (const [price, lon, lat, rooms] of [
      [10000000, 37.61, 55.75, 2],
      [20000000, 37.7, 55.8, 3],
    ]) {
      const id = randomUUID(),
        address = randomUUID(),
        property = randomUUID(),
        listingSource = randomUUID();
      await monitor.run(async () =>
        pool.query(
          "INSERT INTO addresses(id,formatted,locality,district,point) VALUES($1,'Москва, Тверская','Москва','Центр',ST_SetSRID(ST_MakePoint($2,$3),4326))",
          [address, lon, lat],
        ),
      );
      await monitor.run(async () =>
        pool.query(
          "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,$4)",
          [property, seller, address, { area: 50, rooms, elevator: true }],
        ),
      );
      await monitor.run(async () =>
        pool.query("INSERT INTO listing_sources(id,kind) VALUES($1,'direct')", [
          listingSource,
        ]),
      );
      await monitor.run(async () =>
        pool.query(
          "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,price,title,status,published_at) VALUES($1,$2,$3,$4,'sale',$5,$6,'published',now())",
          [
            id,
            property,
            listingSource,
            seller,
            price,
            'Квартира ' + rooms + ' комнаты',
          ],
        ),
      );
    }
    await monitor.run(() => index.initialize());
    const rows = (
      await monitor.run(async () =>
        pool.query('SELECT * FROM public_search_listings'),
      )
    ).rows;
    for (const row of rows)
      await monitor.run(() => index.write(row.id, '1', documentOf(row)));
    await monitor.run(() =>
      index.request('/' + index.alias + '/_refresh', 'POST'),
    );
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
      await monitor.run(() => waitService(url, children));
    }
    stage = 'load-authentication';
    const authentication = await monitor.run(async () => {
      const response = await fetch('http://127.0.0.1:3101/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'buyer@e2e.test',
          password: 'E2E-only-password-42!',
          transport: 'bearer',
        }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (response.status !== 201) throw new Error('Load fixture login failed');
      const login = await readLoadJson(response);
      if (login.user?.id !== buyer || typeof login.sessionToken !== 'string')
        throw new Error('Load fixture identity failed');
      const sessionsResponse = await fetch(
        'http://127.0.0.1:3101/v1/auth/sessions',
        {
          headers: { Authorization: 'Bearer ' + login.sessionToken },
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        },
      );
      if (sessionsResponse.status !== 200)
        throw new Error('Load fixture session failed');
      const sessions = await readLoadJson(sessionsResponse);
      if (!Array.isArray(sessions) || sessions.length !== 1)
        throw new Error('Load fixture session inventory failed');
      return {
        token: login.sessionToken,
        buyerId: buyer,
        sessionId: sessions[0].id,
        listingIds: rows.map((row) => row.id),
      };
    });
    stage = 'load';
    const clients = createLoopbackLoadClients();
    try {
      await monitor.run(() =>
        measureLoad(
          'http://127.0.0.1:3101',
          rows[0].id,
          resolve(directory, 'phase4d-load.json'),
          authentication,
          { fetch: clients.fetch },
        ),
      );
    } finally {
      clients.close();
    }
    stage = 'browser-regression';
    const child = spawn(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test'],
      { cwd: resolve('../web'), env, stdio: 'inherit' },
    );
    const browser = trackProcess(child, 'browser');
    children.push(browser);
    const result = await monitor.run(() => browser.completion);
    process.exitCode = result.code ?? 1;
    failed = failed || process.exitCode !== 0;
    if (
      children.slice(0, -1).some((record) => record.outcome || record.logFailed)
    )
      failed = true;
  } catch {
    failed = true;
    // Bounded identifiers only: no URLs, credentials, private rows or raw errors.
    if (process.env.GITHUB_ACTIONS === 'true')
      console.error(`::error title=E2E preflight::Failed stage: ${stage}`);
  } finally {
    const stopped = await Promise.allSettled(
      children.map((record) => terminate(record)),
    );
    if (
      stopped.some((result) => result.status === 'rejected') ||
      children.some((record) => record.logFailed)
    )
      cleanupFailed = true;
    if (failed && stage === 'load') {
      try {
        const logPath = resolve(directory, 'e2e-api.log');
        if ((await stat(logPath)).size <= 1024 * 1024) {
          const log = await readFile(logPath, 'utf8');
          for (const [scenario, route] of [
            ['catalog', '/v1/categories'],
            ['search', '/v1/search'],
            ['public-detail', '/v1/listings/:id/public'],
            ['map', '/v1/search/map'],
            ['auth-me', '/v1/auth/me'],
            ['auth-sessions', '/v1/auth/sessions'],
          ]) {
            const timing = summarizeLoadSpans(log, route);
            console.error(
              `::notice title=Load server spans::${scenario} count=${timing.count} p95Ms=${timing.p95Ms ?? 'unavailable'} maxMs=${timing.maxMs ?? 'unavailable'}`,
            );
          }
        }
      } catch {
        /* Diagnostics cannot replace the original failed gate. */
      }
    }
    try {
      await index.request('/' + index.alias + '-*', 'DELETE');
    } catch {
      cleanupFailed = true;
    }
    try {
      await boundedOperation(() => pool.end(), 5000);
    } catch {
      cleanupFailed = true;
    }
    try {
      if (databaseCreated)
        await boundedOperation(
          () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`),
          10000,
        );
    } catch {
      cleanupFailed = true;
    }
    try {
      await boundedOperation(() => admin.end(), 5000);
    } catch {
      cleanupFailed = true;
    }
    await writeFile(
      resolve(directory, 'phase4d-e2e-summary.json'),
      JSON.stringify(
        {
          version: 1,
          stage,
          status: failed || cleanupFailed ? 'failed' : 'passed',
          cleanup: cleanupFailed ? 'failed' : 'passed',
          durationMs: Date.now() - started,
          processes: children.map(({ label, outcome }) => ({
            label,
            ...outcome,
          })),
        },
        null,
        2,
      ),
    );
  }
  if (failed || cleanupFailed)
    throw new Error(
      `E2E failed at stage: ${stage}; cleanup: ${cleanupFailed ? 'failed' : 'passed'}`,
    );
}
try {
  await run();
} catch {
  if (process.env.GITHUB_ACTIONS === 'true')
    console.error(`::error title=E2E preflight::Failed stage: ${stage}`);
  console.error(
    stage === 'initialization'
      ? 'E2E initialization failed'
      : `E2E failed at stage: ${stage}`,
  );
  process.exitCode = 1;
}
