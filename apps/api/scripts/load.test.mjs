import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLoad, localLoadTarget } from './load.mjs';
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const context = {
  token: 'PRIVATE_LOAD_TOKEN',
  buyerId: 'PRIVATE_BUYER_ID',
  sessionId: 'PRIVATE_SESSION_ID',
  listingIds: ids,
};
function payload(path) {
  if (path === '/v1/categories') return [{ code: 'apartment' }];
  if (path === '/v1/search')
    return { items: ids.map((id) => ({ id })), total: 2 };
  if (path.endsWith('/public')) return { id: ids[0] };
  if (path === '/v1/search/map')
    return {
      markers: ids.map((id) => ({
        listingIds: [id],
        count: 1,
        longitude: 37.6,
        latitude: 55.7,
      })),
      matched: 2,
      truncated: false,
    };
  if (path === '/v1/auth/me') return { id: context.buyerId, role: 'buyer' };
  if (path === '/v1/auth/sessions')
    return [
      {
        id: context.sessionId,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    ];
  throw new Error('Unexpected fixture route');
}
function runtime(transform = (data) => data, step = 1) {
  let clock = 0;
  const requests = [];
  let evidence;
  return {
    requests,
    get evidence() {
      return evidence;
    },
    options: {
      reportFailure: () => {},
      now: () => (clock += step),
      fetch: async (url, options) => {
        const path = new URL(url).pathname;
        requests.push({ path, options });
        const data = transform(
          payload(path),
          path,
          requests.filter((r) => r.path === path).length,
        );
        return data instanceof Response
          ? data
          : new Response(JSON.stringify(data), {
              status: options.method === 'POST' ? 201 : 200,
            });
      },
      writeEvidence: async (_output, bytes) => {
        evidence = JSON.parse(bytes);
      },
    },
  };
}
test('Critical-read load measures six exact scenarios and keeps credentials out of evidence', async () => {
  const run = runtime();
  await measureLoad(
    'http://127.0.0.1:3101',
    ids[0],
    'fixture.json',
    context,
    run.options,
  );
  assert.equal(run.requests.length, 270);
  assert.deepEqual(
    run.evidence.results.map((r) => r.scenario),
    ['catalog', 'search', 'public-detail', 'map', 'auth-me', 'auth-sessions'],
  );
  for (const result of run.evidence.results) {
    assert.equal(result.requests, 40);
    assert.equal(result.successes, 40);
    assert.equal(result.errors, 0);
    assert.equal(result.warmupErrors, 0);
  }
  for (const path of new Set(run.requests.map((r) => r.path)))
    assert.deepEqual(
      [0, 1, 2, 3].map(
        (slot) =>
          run.requests.filter(
            (r) => r.path === path && r.options.loadClient === slot,
          ).length,
      ),
      [12, 11, 11, 11],
    );
  for (const { path, options } of run.requests) {
    assert.equal(options.redirect, 'error');
    assert.equal(
      options.headers.Authorization,
      path.startsWith('/v1/auth/') ? 'Bearer ' + context.token : undefined,
    );
    assert.equal(
      options.method,
      ['/v1/search', '/v1/search/map'].includes(path) ? 'POST' : 'GET',
    );
  }
  for (const value of [context.token, context.buyerId, context.sessionId])
    assert.ok(!JSON.stringify(run.evidence).includes(value));
});
test('HTTP success with wrong identity, empty sessions or missing map listing cannot pass', async () => {
  for (const route of ['/v1/auth/me', '/v1/auth/sessions', '/v1/search/map']) {
    const run = runtime((data, path) =>
      path !== route
        ? data
        : path.endsWith('/me')
          ? { id: 'wrong', role: 'buyer' }
          : path.endsWith('/sessions')
            ? []
            : { ...data, markers: data.markers.slice(1) },
    );
    await assert.rejects(
      measureLoad(
        'http://127.0.0.1:3101',
        ids[0],
        'fixture.json',
        context,
        run.options,
      ),
      /load/i,
    );
    assert.ok(run.evidence.results.some((result) => result.errors === 40));
  }
});
test('A measured HTTP failure persists accurate error counts before rejecting', async () => {
  const run = runtime((data, path, count) =>
    path === '/v1/search/map' && count === 6
      ? new Response('private provider response', { status: 503 })
      : data,
  );
  await assert.rejects(
    measureLoad(
      'http://127.0.0.1:3101',
      ids[0],
      'fixture.json',
      context,
      run.options,
    ),
    /load/i,
  );
  const result = run.evidence.results.find((r) => r.scenario === 'map');
  assert.equal(result.errors, 1);
  assert.equal(result.successes, 39);
  assert.equal(result.requests, 40);
  assert.ok(
    !JSON.stringify(run.evidence).includes('private provider response'),
  );
});
test('Transport failures and latency breaches retain failed evidence', async () => {
  const failed = runtime();
  failed.options.fetch = async () => {
    throw new Error('PRIVATE_TRANSPORT_MARKER');
  };
  await assert.rejects(
    measureLoad(
      'http://127.0.0.1:3101',
      ids[0],
      'fixture.json',
      context,
      failed.options,
    ),
    /load/i,
  );
  assert.ok(
    failed.evidence.results.every((r) => r.errors === 40 && r.p95Ms === null),
  );
  assert.ok(
    !JSON.stringify(failed.evidence).includes('PRIVATE_TRANSPORT_MARKER'),
  );
  const slow = runtime(undefined, 301);
  await assert.rejects(
    measureLoad(
      'http://127.0.0.1:3101',
      ids[0],
      'fixture.json',
      context,
      slow.options,
    ),
    /load/i,
  );
  assert.ok(slow.evidence.results.some((r) => r.p95Ms > 300));
});
test('Read target allowlist includes map and session reads while rejecting auth mutations', () => {
  for (const path of ['/v1/search/map', '/v1/auth/me', '/v1/auth/sessions'])
    assert.doesNotThrow(() => localLoadTarget('http://127.0.0.1:3101' + path));
  for (const path of [
    '/v1/auth/login',
    '/v1/auth/logout',
    '/v1/admin/operations',
  ])
    assert.throws(() => localLoadTarget('http://127.0.0.1:3101' + path));
});

test('Load rejects an unexpected session even when the expected session is present', async () => {
  const run = runtime((data, path) =>
    path === '/v1/auth/sessions'
      ? [
          ...data,
          {
            id: 'unexpected-private-session',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
        ]
      : data,
  );
  await assert.rejects(
    measureLoad(
      'http://127.0.0.1:3101',
      ids[0],
      'fixture.json',
      context,
      run.options,
    ),
    /load/i,
  );
  assert.equal(
    run.evidence.results.find((result) => result.scenario === 'auth-sessions')
      .errorKinds.contract,
    40,
  );
});
test('Malformed and oversized bodies persist bounded body-error evidence', async () => {
  for (const responseBody of [
    'not JSON PRIVATE_BODY_MARKER',
    'x'.repeat(262145),
  ]) {
    const run = runtime((data, path, count) =>
      path === '/v1/categories' && count === 6
        ? new Response(responseBody, { status: 200 })
        : data,
    );
    await assert.rejects(
      measureLoad(
        'http://127.0.0.1:3101',
        ids[0],
        'fixture.json',
        context,
        run.options,
      ),
      /load/i,
    );
    const result = run.evidence.results.find(
      (result) => result.scenario === 'catalog',
    );
    assert.equal(result.errors, 1);
    assert.equal(result.successes, 39);
    assert.equal(result.errorKinds.body, 1);
    assert.ok(!JSON.stringify(run.evidence).includes('PRIVATE_BODY_MARKER'));
  }
});
test('A warmup-only failure cannot pass a successful measured workload', async () => {
  const run = runtime((data, path, count) =>
    path === '/v1/categories' && count === 1
      ? new Response('fixture', { status: 503 })
      : data,
  );
  await assert.rejects(
    measureLoad(
      'http://127.0.0.1:3101',
      ids[0],
      'fixture.json',
      context,
      run.options,
    ),
    /load/i,
  );
  const result = run.evidence.results.find(
    (result) => result.scenario === 'catalog',
  );
  assert.equal(result.warmupErrors, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.successes, 40);
});

test('Failed load reports only bounded scenario counters and timings for CI diagnosis', async () => {
  const run = runtime((_data, path) =>
    path === '/v1/auth/me' ? { id: 'wrong', role: 'buyer' } : payload(path),
  );
  const reports = [];
  await assert.rejects(
    measureLoad('http://127.0.0.1:3101', ids[0], 'fixture.json', context, {
      ...run.options,
      reportFailure: (line) => reports.push(line),
    }),
  );
  assert.equal(reports.length, 1);
  assert.match(reports[0], /auth-me.*errors=40.*warmupErrors=5/);
  for (const value of [
    context.token,
    context.buyerId,
    context.sessionId,
    ...ids,
    'http:',
    'wrong',
  ])
    assert.ok(!reports.join('').includes(value));
});
