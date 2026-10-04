import assert from 'node:assert/strict';
const api = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001';
const web = process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000';
for (const [base, service] of [
  [api, 'api'],
  [web, 'web'],
]) {
  const response = await fetch(`${base}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service });
}
const ready = await fetch(`${api}/health/ready`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(ready.status, 200);
assert.deepEqual((await ready.json()).dependencies, {
  postgres: 'ok',
  redis: 'ok',
});
const page = await fetch(web, { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /RAUI.RU/);
console.log(
  'Smoke passed: web page, web/API health, PostgreSQL + PostGIS, Redis',
);

const categories = await fetch(`${api}/v1/categories`, {
  signal: AbortSignal.timeout(5000),
});
assert.equal(categories.status, 200);
assert.equal((await categories.json()).length, 10);
const openapi = await fetch(`${api}/v1/openapi.json`, {
  signal: AbortSignal.timeout(5000),
});
assert.equal(openapi.status, 200);
assert.ok((await openapi.json()).paths['/v1/properties']);
assert.equal(
  (await fetch(`${api}/v1/admin/users`, { signal: AbortSignal.timeout(5000) }))
    .status,
  401,
);
console.log('Core smoke passed: migrated categories, OpenAPI, protected admin');
