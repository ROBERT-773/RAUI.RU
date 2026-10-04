import assert from 'node:assert/strict';
const api = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001',
  web = process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000';
async function search(path, body) {
  const response = await fetch(api + '/v1/search' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 201);
  return response.json();
}
const page = await search('', { q: 'Локальная smoke-проверка', limit: 50 });
assert.ok(
  page.items.length > 0,
  'Run core smoke and search reconciliation first',
);
const mapped = await search('/map', {
  q: 'Локальная smoke-проверка',
  bounds: [37, 55, 38, 56],
});
assert.ok(mapped.matched > 0);
const first = page.items[0];
const detail = await fetch(web + '/listings/' + first.id, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(detail.status, 200);
const html = await detail.text();
assert.match(html, /RealEstateListing/);
assert.match(html, /canonical/);
assert.match(html, /Локальная smoke-проверка/);
const selected = await search('/selection', {
  ids: [first.id],
  definition: {},
});
assert.equal(selected.items[0].id, first.id);
console.log(
  'Built search smoke passed: real index, PostGIS map, selection, SSR detail, canonical and structured data',
);
