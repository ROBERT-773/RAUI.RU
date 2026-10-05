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
