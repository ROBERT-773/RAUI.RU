import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  trackProcess,
  waitService,
  terminate,
  boundedOperation,
  watchPoolErrors,
} from './e2e-runtime.mjs';
const timeout = (milliseconds) =>
  new Promise((resolve) =>
    setTimeout(() => resolve('unbounded'), milliseconds),
  );
const outcome = (promise) =>
  promise.then(
    () => 'success',
    () => 'rejected',
  );
test('Initialization errors cannot print credential-bearing database URLs', () => {
  const marker = 'SYNTHETIC_PRIVATE_STARTUP_MARKER';
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./product-e2e.mjs', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
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
  assert.match(result.stderr, /E2E initialization failed/);
});
test('Readiness deadline rejects even when fetch never settles', async () => {
  const signals = [];
  const result = await Promise.race([
    outcome(
      waitService('http://127.0.0.1/health', [], {
        deadlineMs: 40,
        requestMs: 10,
        pollMs: 1,
        fetch: (_url, { signal }) => {
          signals.push(signal);
          return new Promise(() => {});
        },
      }),
    ),
    timeout(200),
  ]);
  assert.equal(result, 'rejected');
  assert.ok(signals.length > 0 && signals.every((signal) => signal.aborted));
});
test('Readiness cancels response bodies and cleanup cannot hang on diagnostics streams', async () => {
  let cancelled = false;
  await waitService('http://127.0.0.1/health', [], {
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal(cancelled, true);
  const child = new EventEmitter();
  const record = trackProcess(child, 'api');
  child.emit('exit', 0, null);
  record.logCompletion = new Promise(() => {});
  await assert.rejects(
    terminate(record, { logMs: 10 }),
    /log cleanup deadline/,
  );
});
test('Spawn failure is handled immediately and aborts readiness', async () => {
  const child = new EventEmitter();
  const record = trackProcess(child, 'api');
  assert.doesNotThrow(() =>
    child.emit('error', new Error('private fixture error')),
  );
  assert.equal(record.outcome.spawnError, true);
  await assert.rejects(
    waitService('http://127.0.0.1/health', [record], {
      fetch: async () => new Response('ok'),
    }),
    /Service exited/,
  );
});
test('Readiness rejects a service that already exited normally', async () => {
  const child = new EventEmitter();
  const record = trackProcess(child, 'api');
  child.emit('exit', 0, null);
  await assert.rejects(
    waitService('http://127.0.0.1/health', [record], {
      fetch: async () => new Response('ok'),
    }),
    /Service exited/,
  );
});
test('Cleanup recognizes an earlier signal exit and escalates an ignored SIGTERM', async () => {
  const ended = new EventEmitter();
  ended.exitCode = null;
  ended.signalCode = 'SIGTERM';
  ended.kill = () => {
    throw new Error('Already exited process must not be killed');
  };
  const first = trackProcess(ended, 'api');
  ended.emit('exit', null, 'SIGTERM');
  assert.equal(
    await Promise.race([
      outcome(terminate(first, { termMs: 10, killMs: 10 })),
      timeout(100),
    ]),
    'success',
  );
  const child = new EventEmitter();
  child.exitCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL')
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  };
  const record = trackProcess(child, 'web');
  assert.equal(
    await Promise.race([
      outcome(terminate(record, { termMs: 10, killMs: 10 })),
      timeout(100),
    ]),
    'success',
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('Late log errors and permanently stuck cleanup operations cannot pass', async () => {
  const child = new EventEmitter();
  const record = trackProcess(child, 'api');
  child.emit('exit', 0, null);
  record.logCompletion = new Promise((resolve) =>
    queueMicrotask(() => {
      record.logFailed = true;
      resolve();
    }),
  );
  await assert.rejects(terminate(record), /log cleanup failed/);
  await assert.rejects(
    boundedOperation(() => new Promise(() => {}), 10),
    /cleanup deadline/,
  );
  assert.equal(
    await boundedOperation(() => Promise.resolve('complete'), 10),
    'complete',
  );
});

test('Idle database errors are sanitized, abort pending work and retain cleanup access', async () => {
  const pool = new EventEmitter();
  const marker = 'PRIVATE_DATABASE_IDLE_ERROR';
  let failures = 0;
  const monitor = watchPoolErrors([pool], () => failures++);
  const waiting = monitor.run(() => new Promise(() => {}));
  assert.doesNotThrow(() => pool.emit('error', new Error(marker)));
  await assert.rejects(waiting, (error) => {
    assert.equal(error.message, 'E2E database connection failed');
    assert.ok(!error.stack.includes(marker));
    return true;
  });
  let invoked = false;
  await assert.rejects(
    monitor.run(() => {
      invoked = true;
    }),
    /database connection failed/,
  );
  assert.equal(invoked, false);
  assert.equal(failures, 1);
  let cleaned = false;
  await boundedOperation(async () => {
    cleaned = true;
  }, 50);
  assert.equal(cleaned, true);
});

test('Idle error fences an operation queued for the next microtask', async () => {
  const pool = new EventEmitter();
  const monitor = watchPoolErrors([pool], () => {});
  let invoked = false;
  const pending = monitor.run(() => {
    invoked = true;
  });
  pool.emit('error', new Error('private fixture'));
  await assert.rejects(pending, /database connection failed/);
  assert.equal(invoked, false);
});

test('Load server-span diagnostics expose only bounded public route timings', async () => {
  const { summarizeLoadSpans } = await import('./e2e-runtime.mjs');
  const rows = [
    {
      event: 'http_span',
      route: '/v1/listings/:id/public',
      method: 'GET',
      status: 200,
      durationMs: 5,
      traceId: 'PRIVATE_TRACE',
    },
    {
      event: 'http_span',
      route: '/v1/listings/:id/public',
      method: 'GET',
      status: 200,
      durationMs: 401,
      body: 'PRIVATE_BODY',
    },
    {
      event: 'http_span',
      route: '/v1/auth/login',
      method: 'POST',
      status: 201,
      durationMs: 3000,
    },
    {
      event: 'http_span',
      route: '/v1/listings/:id/public',
      method: 'GET',
      status: 200,
      durationMs: -1,
    },
  ];
  const summary = summarizeLoadSpans(
    rows.map((r) => JSON.stringify(r)).join('\n') + '\nprivate raw error',
  );
  assert.deepEqual(summary, { count: 2, p95Ms: 401, maxMs: 401 });
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
  assert.deepEqual(summarizeLoadSpans('x'.repeat(1024 * 1024 + 1)), {
    count: 0,
    p95Ms: null,
    maxMs: null,
  });
});

test('Map server-span diagnostics count successful POST 201 responses', async () => {
  const { summarizeLoadSpans } = await import('./e2e-runtime.mjs');
  assert.deepEqual(
    summarizeLoadSpans(
      JSON.stringify({
        event: 'http_span',
        route: '/v1/search/map',
        method: 'POST',
        status: 201,
        durationMs: 42,
      }),
      '/v1/search/map',
    ),
    { count: 1, p95Ms: 42, maxMs: 42 },
  );
});

test('Slow-query diagnostics retain fixed query classes and numeric timings only', async () => {
  const { summarizeSlowQueries } = await import('./e2e-runtime.mjs');
  const input =
    'postgres | LOG: duration: 280.42 ms execute <unnamed>: SELECT l.* FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1\nDETAIL: parameters: $1 = PRIVATE_ID\nLOG: duration: 100.25 ms execute <unnamed>: SELECT p.id,p.category_code,p.attributes,a.formatted FROM properties p\nLOG: duration: 120 ms execute <unnamed>: SELECT id,kind,variants FROM media WHERE listing_id=$1\nLOG: duration: 200 ms execute <unnamed>: SELECT PRIVATE_TOKEN FROM sessions';
  const summary = summarizeSlowQueries(input);
  assert.deepEqual(summary, [
    { query: 'visibility', count: 1, maxMs: 280.42 },
    { query: 'property', count: 1, maxMs: 100.25 },
    { query: 'media', count: 1, maxMs: 120 },
  ]);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});
