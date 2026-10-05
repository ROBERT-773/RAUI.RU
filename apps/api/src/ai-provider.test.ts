import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import * as config from './config';
import { GatewayAiProvider } from './modules/ai/provider';
const requestId = 'f480f8c9-86b3-4ac3-9ca0-78d9b1d591ff';
const input = {
  requestId,
  capability: 'search',
  promptVersion: 'phase4c-v1',
  context: { query: 'Квартира' },
  limits: { maxOutputTokens: 1000, maxCostMicros: 100000 },
};
function testConfig() {
  return config.envSchema.parse({
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
    AI_GATEWAY_URL: 'https://gateway.example/generate',
    AI_ALLOWED_HOSTS: 'gateway.example',
    AI_GATEWAY_TOKEN: 'test-only-provider-token',
  });
}
test('AI gateway pins all-validated DNS into TLS transport, bounds responses and never follows redirects', async (t) => {
  const cfg = testConfig();
  t.mock.method(config, 'loadConfig', () => cfg);
  let addresses = [{ address: '8.8.8.8', family: 4 }],
    requests = 0,
    status = 200,
    body = '{"suggestion":"Review facts"}',
    destroyed = false;
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: (
      res: EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy(): void;
      },
    ) => void,
  ) => {
    requests++;
    assert.equal(url.hostname, 'gateway.example');
    assert.equal(options.family, 4);
    assert.equal(options.servername, 'gateway.example');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(
      (options.headers as Record<string, string>)['Idempotency-Key'],
      requestId,
    );
    options.lookup!('gateway.example', {}, (_err, address, family) => {
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const req = new EventEmitter();
    return Object.assign(req, {
      destroy() {
        destroyed = true;
      },
      end(payload: string) {
        assert.deepEqual(JSON.parse(payload), input);
        const res = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers: { 'content-type': 'application/json' },
          destroy() {
            destroyed = true;
          },
        });
        callback(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      },
    });
  }) as never);
  const provider = new GatewayAiProvider(),
    signal = new AbortController().signal;
  assert.deepEqual(await provider.generate(input, signal), {
    suggestion: 'Review facts',
  });
  assert.equal(requests, 1);
  addresses = [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(provider.generate(input, signal), /ai_address_rejected/);
  assert.equal(requests, 1);
  addresses = [{ address: '8.8.8.8', family: 4 }];
  status = 302;
  await assert.rejects(
    provider.generate(input, signal),
    /ai_response_rejected/,
  );
  assert.equal(requests, 2);
  status = 200;
  body = 'x'.repeat(64001);
  await assert.rejects(provider.generate(input, signal), /ai_output_limit/);
  assert.equal(destroyed, true);
  const escaped = [...cfg.AI_GATEWAY_TOKEN!]
    .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  body =
    '{"suggestion":"' +
    escaped +
    '","confidence":0.6,"modelVersion":"test-v1","usage":{"inputTokens":1,"outputTokens":1,"costMicros":1}}';
  assert.ok(!body.includes(cfg.AI_GATEWAY_TOKEN!));
  await assert.rejects(
    provider.generate(input, signal),
    /ai_response_rejected/,
  );
  body = JSON.stringify({ suggestion: cfg.AI_GATEWAY_TOKEN });
  await assert.rejects(
    provider.generate(input, signal),
    /ai_response_rejected/,
  );
});
test('AI gateway rejects IP literals, missing allowlist, private DNS and pre-aborted calls before transport', async (t) => {
  let cfg = testConfig(),
    requests = 0;
  t.mock.method(config, 'loadConfig', () => cfg);
  t.mock.method(https, 'request', () => {
    requests++;
    throw new Error('must not call');
  });
  t.mock.method(dns, 'lookup', async () => [
    { address: '169.254.169.254', family: 4 },
  ]);
  const provider = new GatewayAiProvider(),
    signal = new AbortController().signal;
  await assert.rejects(provider.generate(input, signal), /ai_address_rejected/);
  cfg = { ...cfg, AI_GATEWAY_URL: 'https://[::1]/generate' };
  await assert.rejects(provider.generate(input, signal));
  cfg = { ...testConfig(), AI_ALLOWED_HOSTS: '' };
  await assert.rejects(provider.generate(input, signal));
  cfg = testConfig();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.generate(input, controller.signal),
    /ai_aborted/,
  );
  assert.equal(requests, 0);
});
