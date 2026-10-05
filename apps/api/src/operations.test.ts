import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchHealthy } from './modules/operations/operations';
import { Telemetry, requestTrace } from './modules/operations/telemetry';
test('Telemetry labels only registered route templates and bounded method/status classes', () => {
  const metrics = new Telemetry();
  metrics.routes(['/v1/listings/:id']);
  for (let n = 0; n < 1000; n++)
    metrics.record('/private/' + n, 'secret' + n, 599, 0.4);
  metrics.record('/v1/listings/:id', 'GET', 200, 0.1);
  const output = metrics.prometheus();
  assert.ok(output.includes('route="unmatched",method="OTHER",status="5xx"'));
  assert.ok(output.includes('route="/v1/listings/:id"'));
  assert.ok(!output.includes('/private/') && !output.includes('secret'));
  assert.ok(output.length < 10000);
  assert.ok(output.includes('le="0.3"} 1'));
});
test('Trace IDs are generated or strictly W3C validated and caller identifiers never become log metadata', () => {
  for (const value of [
    'private-secret',
    '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01',
    '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01\nsecret',
  ]) {
    const trace = requestTrace(value);
    assert.match(trace.traceId, /^[a-f0-9]{32}$/);
    assert.match(trace.spanId, /^[a-f0-9]{16}$/);
    assert.notEqual(trace.traceId, '0'.repeat(32));
    assert.equal(trace.parentSpanId, undefined);
  }
  const trace = requestTrace(
    '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01',
  );
  assert.equal(trace.traceId, 'a'.repeat(32));
  assert.equal(trace.parentSpanId, 'b'.repeat(16));
});

test('Search dependency rejects red/malformed/oversized cluster health responses even on HTTP 200', async () => {
  for (const status of ['red', 'private-secret', undefined]) {
    assert.equal(
      await searchHealthy(new Response(JSON.stringify({ status }))),
      false,
    );
  }
  assert.equal(
    await searchHealthy(new Response(JSON.stringify({ status: 'green' }))),
    true,
  );
  assert.equal(
    await searchHealthy(new Response(JSON.stringify({ status: 'yellow' }))),
    true,
  );
  assert.equal(await searchHealthy(new Response('x'.repeat(16385))), false);
});
