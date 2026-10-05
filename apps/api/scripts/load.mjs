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
    !/^\/(health|v1\/categories|v1\/search|v1\/listings\/[a-f0-9-]{36}\/public)$/.test(
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
export async function measureLoad(base, listingId, output) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Production load forbidden');
  const cases = [
    { name: 'catalog', path: '/v1/categories' },
    { name: 'search', path: '/v1/search', body: {} },
    { name: 'public-detail', path: '/v1/listings/' + listingId + '/public' },
  ];
  const results = [];
  for (const scenario of cases) {
    const url = localLoadTarget(base + scenario.path);
    const request = async () => {
      const started = performance.now();
      const response = await fetch(url, {
        method: scenario.body ? 'POST' : 'GET',
        ...(scenario.body
          ? {
              body: JSON.stringify(scenario.body),
              headers: { 'Content-Type': 'application/json' },
            }
          : {}),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      // Consume the bounded fixture body so timing includes network delivery.
      const bytes = await response.arrayBuffer();
      if (
        (response.status !== 200 && response.status !== 201) ||
        bytes.byteLength > 262144
      )
        throw new Error('Load scenario failed: ' + scenario.name);
      return performance.now() - started;
    };
    for (let n = 0; n < 5; n++) await request();
    const timings = [],
      started = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let n = 0; n < 10; n++) timings.push(await request());
      }),
    );
    const elapsed = performance.now() - started;
    results.push({
      scenario: scenario.name,
      requests: timings.length,
      concurrency: 4,
      warmup: 5,
      errors: 0,
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      p99Ms: percentile(timings, 0.99),
      requestsPerSecond: timings.length / (elapsed / 1000),
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
      'two published listings; isolated scratch PostgreSQL/PostGIS and OpenSearch index; warm local workload',
    results,
  };
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', {
    mode: 0o600,
  });
  if (results.some((result) => result.p95Ms > 300))
    throw new Error(
      'Measured ordinary API p95 exceeds 300 ms; inspect load artifact',
    );
  console.log(
    'Local load: catalog/search/public detail, 120 measured requests, concurrency 4, p95 <=300 ms',
  );
}
