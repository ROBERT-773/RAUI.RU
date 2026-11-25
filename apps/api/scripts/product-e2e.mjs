import { measureLoad, readLoadJson } from './load.mjs';
import { Pool } from 'pg';
import { createLoopbackLoadClients } from './load-transport.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import {
  trackProcess,
  waitService,
  terminate,
  boundedOperation,
  watchPoolErrors,
  summarizeLoadSpans,
} from './e2e-runtime.mjs';
import { resolve } from 'node:path';
import { openCodeTestOrigin } from './e2e-code-https.mjs';
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
  const precreated = process.env.RAUI_E2E_PRECREATED_DATABASE;
  const publicationOnly = process.argv.includes('--publication-only');
  const onboardingOnly = process.argv.includes('--onboarding-only');
  const staffTotpOnly = process.argv.includes('--staff-totp-only');
  const smsOnly = process.argv.includes('--sms-only');
  const emailCodeOnly = process.argv.includes('--email-code-only');
  const feedsOnly = process.argv.includes('--feeds-only');
  const trustedFeeds = staffTotpOnly || feedsOnly;
  if (
    [
      publicationOnly,
      onboardingOnly,
      staffTotpOnly,
      smsOnly,
      emailCodeOnly,
      feedsOnly,
    ].filter(Boolean).length > 1
  )
    throw new Error('Select one focused E2E scenario');
  const focusedSpecs = publicationOnly
    ? ['e2e/owner-publication.spec.ts']
    : onboardingOnly
      ? ['e2e/registration-onboarding.spec.ts']
      : staffTotpOnly
        ? [
            'e2e/staff-two-factor.spec.ts',
            'e2e/professional-feed-trust.spec.ts',
          ]
        : smsOnly
          ? ['e2e/phone-sign-in.spec.ts']
          : emailCodeOnly
            ? ['e2e/email-code-sign-in.spec.ts']
            : feedsOnly
              ? [
                  'e2e/professional-feeds.spec.ts',
                  'e2e/professional-feed-trust.spec.ts',
                ]
              : [];
  const runFeeds = trustedFeeds || !focusedSpecs.length;
  if (
    precreated !== undefined &&
    (!/^raui_test_[a-f0-9]{16}$/.test(precreated) ||
      source.pathname !== '/' + precreated)
  )
    throw new Error('Invalid precreated E2E database');
  const name = precreated ?? 'raui_test_' + randomBytes(8).toString('hex'),
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
    E2E_STAFF_TOTP: staffTotpOnly ? 'true' : 'false',
    E2E_TRUSTED_FEEDS: trustedFeeds ? 'true' : 'false',
    STAFF_TOTP_REQUIRED: trustedFeeds ? 'true' : 'false',
    STAFF_TOTP_ENCRYPTION_KEY: trustedFeeds
      ? randomBytes(32).toString('hex')
      : undefined,
    E2E_SMS: smsOnly ? 'true' : 'false',
    E2E_EMAIL_CODE: emailCodeOnly ? 'true' : 'false',
    EMAIL_SIGN_IN_ENABLED: emailCodeOnly ? 'true' : 'false',
    ...(runFeeds
      ? {
          E2E_XML_FEEDS: 'true',
          FEED_ALLOWED_HOSTS: 'xml-fixture.example.test',
        }
      : {}),
    ...(smsOnly
      ? {
          PHONE_OTP_PEPPER: randomBytes(32).toString('base64url'),
          PHONE_OTP_GATEWAY_URL: 'https://sms.example.test/dispatch',
          PHONE_OTP_GATEWAY_TOKEN: 'browser-fixture-only',
        }
      : {}),
  };
  process.env.OPENSEARCH_ALIAS = env.OPENSEARCH_ALIAS;
  const index = new SearchIndex(),
    children = [];
  const directory = resolve('../../.cache');
  stage = 'fixtures';
  let databaseCreated = false;
  let privateDirectory;
  let codeOrigin;
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
    privateDirectory = await mkdtemp(
      resolve(directory, 'product-e2e-private-'),
    );
    env.LOCAL_PRIVATE_DIR = privateDirectory;
    env.VERIFICATION_GATEWAY_URL = undefined;
    env.VERIFICATION_GATEWAY_TOKEN = undefined;
    env.RESET_SMTP_ENABLED = emailCodeOnly ? 'true' : 'false';
    if (emailCodeOnly) {
      codeOrigin = await openCodeTestOrigin(privateDirectory);
      env.WEB_ORIGIN = env.SITE_URL = env.E2E_BASE_URL = codeOrigin.origin;
      env.RESET_SMTP_PASSWORD = randomBytes(24).toString('hex');
      env.EMAIL_SIGN_IN_PEPPER = randomBytes(32).toString('base64url');
    }
    env.PHONE_OTP_ENABLED = smsOnly ? 'true' : 'false';
    env.PHONE_SIGN_IN_ENABLED = smsOnly ? 'true' : 'false';
    // Resource allocation must settle before cleanup can decide ownership.
    // An idle error is sticky but cannot race successful CREATE registration.
    stage = 'fixture-database';
    if (!precreated) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      databaseCreated = true;
    }
    const {
      rows: [database],
    } = await monitor.run(() =>
      pool.query(
        "SELECT current_database() AS name, NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public') AS empty",
      ),
    );
    if (database?.name !== name || !database.empty)
      throw new Error('E2E database isolation unavailable');
    stage = 'fixture-migrations';
    await monitor.run(() => migrate(pool));
    stage = 'fixture-records';
    const seller = randomUUID(),
      buyer = randomUUID();
    for (const [id, email, role, verified = true] of [
      [seller, 'seller@e2e.test', 'owner'],
      [buyer, 'buyer@e2e.test', 'buyer'],
      [randomUUID(), 'outsider@e2e.test', 'buyer'],
      [randomUUID(), 'admin@e2e.test', 'admin'],
      [randomUUID(), 'unverified@e2e.test', 'owner', false],
      // Keep quota journeys isolated from legacy catalog listings and from
      // each browser's three-publications-per-month counter.
      ...[
        'chromium',
        'firefox',
        'webkit',
        'ios-webkit',
        'android-chromium',
      ].flatMap((project) => [
        [randomUUID(), `quota-${project}@e2e.test`, 'owner'],
        [randomUUID(), `agency-${project}@e2e.test`, 'agency'],
        [randomUUID(), `agent-${project}@e2e.test`, 'agent'],
        ...(emailCodeOnly
          ? [[randomUUID(), `code-recovery-${project}@e2e.test`, 'agent']]
          : []),
        ...(runFeeds
          ? [[randomUUID(), `developer-${project}@e2e.test`, 'developer']]
          : []),
        ...(staffTotpOnly
          ? [[randomUUID(), `staff-${project}@e2e.test`, 'admin']]
          : []),
        ...(trustedFeeds
          ? [
              [randomUUID(), `feed-admin-${project}@e2e.test`, 'admin'],
              [randomUUID(), `feed-owner-${project}@e2e.test`, 'agency'],
            ]
          : []),
      ]),
    ])
      await monitor.run(async () =>
        pool.query(
          'INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() END,CASE WHEN $6 THEN now() END)',
          [
            id,
            email,
            await passwordHash('E2E-only-password-42!'),
            'Тестовый пользователь',
            role,
            verified,
          ],
        ),
      );
    // One private verified phone per browser's owner, for explicit public contact selection.
    await monitor.run(() =>
      pool.query(
        "WITH owners AS (SELECT id,row_number() OVER (ORDER BY email) n FROM users WHERE email LIKE 'quota-%@e2e.test') UPDATE users SET phone='+7000000100'||owners.n::text FROM owners WHERE users.id=owners.id",
      ),
    );
    if (smsOnly)
      await monitor.run(async () => {
        await pool.query(
          "UPDATE users SET phone='+700000000'||lpad((length(split_part(email,'@',1))-6)::text,2,'0') WHERE email LIKE 'agent-%@e2e.test'",
        );
        await pool.query(
          "UPDATE users SET phone_sign_in_enrolled_at=now() WHERE email LIKE 'agent-%@e2e.test'",
        );
      });
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
    stage = 'fixture-index';
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
    stage = 'fixture-services';
    start(
      [
        emailCodeOnly
          ? 'scripts/e2e-email-code-server.mjs'
          : smsOnly
            ? 'scripts/e2e-sms-server.mjs'
            : 'dist/main.js',
      ],
      process.cwd(),
      'e2e-api',
    );
    start(['dist/worker.js'], process.cwd(), 'e2e-media-worker');
    start(['dist/search-worker.js'], process.cwd(), 'e2e-search-worker');
    if (runFeeds)
      start(['scripts/e2e-feed-worker.mjs'], process.cwd(), 'e2e-feed-worker');
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
    if (!focusedSpecs.length) {
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
        if (response.status !== 201)
          throw new Error('Load fixture login failed');
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
    }
    stage = 'browser-regression';
    const projects =
      smsOnly || emailCodeOnly
        ? env.CHROMIUM_EXECUTABLE
          ? ['chromium', 'android-chromium']
          : ['chromium', 'firefox', 'webkit', 'ios-webkit', 'android-chromium']
        : [null];
    const services = children.slice();
    for (const project of projects) {
      if (project) {
        // All browser profiles reach this disposable API through one loopback IP.
        await monitor.run(() =>
          pool.query(
            "DELETE FROM rate_limits WHERE key IN ('auth:127.0.0.1', 'auth:::1')",
          ),
        );
      }
      const child = spawn(
        process.execPath,
        [
          'node_modules/@playwright/test/cli.js',
          'test',
          ...focusedSpecs,
          ...(project ? ['--project', project] : []),
        ],
        { cwd: resolve('../web'), env, stdio: 'inherit' },
      );
      const browser = trackProcess(child, 'browser');
      children.push(browser);
      const result = await monitor.run(() => browser.completion);
      if (result.code !== 0) {
        process.exitCode = result.code ?? 1;
        failed = true;
      }
    }
    if (services.some((record) => record.outcome || record.logFailed))
      failed = true;
  } catch (error) {
    failed = true;
    if (/^[A-Z0-9]{5,20}$/.test(error?.code ?? ''))
      console.error('E2E failure code: ' + error.code);
    if (/^[a-z][a-z0-9_]{0,62}$/.test(error?.constraint ?? ''))
      console.error('E2E constraint: ' + error.constraint);
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
    try {
      if (codeOrigin) await codeOrigin.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (privateDirectory)
        await rm(privateDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
    await writeFile(
      resolve(
        directory,
        publicationOnly
          ? 'publication-e2e-summary.json'
          : onboardingOnly
            ? 'onboarding-e2e-summary.json'
            : staffTotpOnly
              ? 'staff-totp-e2e-summary.json'
              : smsOnly
                ? 'sms-e2e-summary.json'
                : emailCodeOnly
                  ? 'email-code-e2e-summary.json'
                  : feedsOnly
                    ? 'feeds-e2e-summary.json'
                    : 'phase4d-e2e-summary.json',
      ),
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
