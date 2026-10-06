import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
export function localLoadTarget(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(health|v1\/categories|v1\/search(?:\/map)?|v1\/auth\/(?:me|sessions)|v1\/listings\/[a-f0-9-]{36}\/public)$/.test(
      url.pathname,
    )
  )
    throw new Error('Load requires an explicit allowed loopback read target');
  return url;
}
export function percentile(values, quantile) {
  if (
    !values.length ||
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    quantile <= 0 ||
    quantile > 1
  )
    throw new Error('Invalid timings');
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(quantile * ordered.length) - 1];
}
export async function readLoadJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing load response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw new Error('Oversized load response');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function measureLoad(
  base,
  listingId,
  output,
  context,
  runtime = {},
) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Production load forbidden');
  if (
    !context?.token ||
    !context.buyerId ||
    !context.sessionId ||
    !Array.isArray(context.listingIds) ||
    context.listingIds.length !== 2
  )
    throw new Error('Load requires controlled auth/listing fixture');
  const sameIds = (values) =>
    Array.isArray(values) &&
    values.length === context.listingIds.length &&
    [...values]
      .sort()
      .every((id, index) => id === [...context.listingIds].sort()[index]);
  const cases = [
    {
      name: 'catalog',
      path: '/v1/categories',
      accept: (data) =>
        Array.isArray(data) && data.some((item) => item.code === 'apartment'),
    },
    {
      name: 'search',
      path: '/v1/search',
      body: {},
      accept: (data) =>
        data.total === 2 && sameIds(data.items?.map((item) => item.id)),
    },
    {
      name: 'public-detail',
      path: '/v1/listings/' + listingId + '/public',
      accept: (data) => data.id === listingId,
    },
    {
      name: 'map',
      path: '/v1/search/map',
      body: { bounds: [37.5, 55.6, 37.9, 56] },
      accept: (data) =>
        data.matched === 2 &&
        data.truncated === false &&
        Array.isArray(data.markers) &&
        data.markers.every(
          (marker) =>
            Number.isFinite(marker.longitude) &&
            Number.isFinite(marker.latitude) &&
            Array.isArray(marker.listingIds) &&
            marker.count === marker.listingIds.length,
        ) &&
        sameIds(data.markers.flatMap((marker) => marker.listingIds)),
    },
    {
      name: 'auth-me',
      path: '/v1/auth/me',
      auth: true,
      accept: (data) => data.id === context.buyerId && data.role === 'buyer',
    },
    {
      name: 'auth-sessions',
      path: '/v1/auth/sessions',
      auth: true,
      accept: (data) =>
        Array.isArray(data) &&
        data.length === 1 &&
        data.some(
          (session) =>
            session.id === context.sessionId &&
            Date.parse(session.expires_at) > Date.now(),
        ),
    },
  ];
  const requestFetch = runtime.fetch ?? fetch,
    now = runtime.now ?? (() => performance.now());
  const results = [];
  for (const scenario of cases) {
    const url = localLoadTarget(base + scenario.path);
    const request = async () => {
      const started = now();
      let kind = 'transport';
      try {
        const response = await requestFetch(url, {
          method: scenario.body ? 'POST' : 'GET',
          headers: {
            ...(scenario.body ? { 'Content-Type': 'application/json' } : {}),
            ...(scenario.auth
              ? { Authorization: 'Bearer ' + context.token }
              : {}),
          },
          ...(scenario.body ? { body: JSON.stringify(scenario.body) } : {}),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        kind = 'status';
        if (response.status !== (scenario.body ? 201 : 200)) {
          await response.body?.cancel();
          throw new Error('Load status failed');
        }
        kind = 'body';
        const data = await readLoadJson(response);
        kind = 'contract';
        if (!scenario.accept(data)) throw new Error('Load contract failed');
        return { ok: true, durationMs: now() - started };
      } catch {
        return { ok: false, kind };
      }
    };
    let warmupErrors = 0;
    for (let n = 0; n < 5; n++) if (!(await request()).ok) warmupErrors++;
    const timings = [],
      errorKinds = { transport: 0, status: 0, body: 0, contract: 0 };
    let errors = 0;
    const started = now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let n = 0; n < 10; n++) {
          const result = await request();
          if (result.ok) timings.push(result.durationMs);
          else {
            errors++;
            errorKinds[result.kind]++;
          }
        }
      }),
    );
    const elapsed = now() - started;
    results.push({
      scenario: scenario.name,
      requests: 40,
      successes: timings.length,
      concurrency: 4,
      warmup: 5,
      warmupErrors,
      errors,
      errorKinds,
      p50Ms: timings.length ? percentile(timings, 0.5) : null,
      p95Ms: timings.length ? percentile(timings, 0.95) : null,
      p99Ms: timings.length ? percentile(timings, 0.99) : null,
      requestsPerSecond: 40 / (elapsed / 1000),
      targetP95Ms: 300,
    });
  }
  const evidence = {
    version: 1,
    measuredAt: new Date().toISOString(),
    runtime: process.version,
    availableCpuCount: cpus().length,
    availableMemoryBytes: totalmem(),
    fixture:
      'two published listings and one buyer session; isolated scratch PostgreSQL/PostGIS and OpenSearch; warm local read workload across four native loopback peers; application rate quotas unchanged',
    results,
  };
  await (runtime.writeEvidence ?? writeFile)(
    output,
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
  if (
    results.some(
      (result) =>
        result.errors ||
        result.warmupErrors ||
        result.p95Ms === null ||
        result.p95Ms > 300,
    )
  ) {
    for (const result of results.filter(
      (r) => r.errors || r.warmupErrors || r.p95Ms === null || r.p95Ms > 300,
    )) {
      const timing = Number.isFinite(result.p95Ms)
        ? result.p95Ms.toFixed(2)
        : 'unavailable';
      (runtime.reportFailure ?? console.error)(
        `::error title=Load scenario::${result.scenario} errors=${result.errors} warmupErrors=${result.warmupErrors} p95Ms=${timing} transport=${result.errorKinds.transport} status=${result.errorKinds.status} body=${result.errorKinds.body} contract=${result.errorKinds.contract}`,
      );
    }
    throw new Error('Measured load failed; inspect bounded load evidence');
  }
  console.log(
    'Local load: six critical read scenarios,240 measured requests,concurrency4,p95<=300ms',
  );
}
