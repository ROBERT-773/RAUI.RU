import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import * as config from './config';
import { RateGuard } from './common/security';
import { normalizeIp } from '@raui/config/ingress';

test('Forwarded IP canonicalization rejects scoped IPv6 without throwing', () => {
  assert.equal(normalizeIp('fe80::1%eth0'), null);
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(
    normalizeIp('2001:4860:4860:0:0:0:0:8888'),
    '2001:4860:4860::8888',
  );
});

const secret = 'synthetic-forwarding-key-'.repeat(2);
function signed(
  ip: string,
  method = 'POST',
  target = '/v1/search',
  at = Date.now(),
) {
  return {
    'x-raui-client-ip': ip,
    'x-raui-forwarded-at': String(at),
    'x-raui-forwarded-signature': createHmac('sha256', secret)
      .update(JSON.stringify([1, method, target, ip, String(at)]))
      .digest('hex'),
  };
}
function context(
  headers: Record<string, string> = {},
  peer = '127.0.0.1',
  method = 'POST',
  target = '/v1/search',
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        url: target,
        originalUrl: target,
        method,
        headers,
        ip: peer,
        socket: { remoteAddress: peer },
      }),
    }),
  } as ExecutionContext;
}
function guard(t: TestContext) {
  t.mock.method(config, 'loadConfig', () => ({
    ...config.envSchema.parse({
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
    }),
    PROXY_IDENTITY_SECRET: secret,
    TRUSTED_PROXY_PEERS: '127.0.0.1',
  }));
  const counts = new Map<string, number>();
  return new RateGuard({
    rows: async (_sql: string, values: string[]) => {
      const key = values[0]!;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return [{ count }];
    },
  } as never);
}
test('Trusted proxy clients retain independent rate quotas and aggregate abuse bounds', async (t) => {
  const rate = guard(t);
  for (let n = 0; n < 160; n++) {
    assert.equal(await rate.canActivate(context(signed('8.8.8.8'))), true);
    assert.equal(await rate.canActivate(context(signed('8.8.4.4'))), true);
  }
  for (let n = 160; n < 300; n++)
    await rate.canActivate(context(signed('8.8.8.8')));
  await assert.rejects(
    rate.canActivate(context(signed('8.8.8.8'))),
    /Rate limit exceeded/,
  );
  assert.equal(await rate.canActivate(context(signed('8.8.4.4'))), true);
  const aggregate = guard(t);
  for (let n = 0; n < 3000; n++)
    await aggregate.canActivate(context(signed(`8.8.0.${1 + (n % 200)}`)));
  await assert.rejects(
    aggregate.canActivate(context(signed('8.8.4.4'))),
    /Rate limit exceeded/,
  );
});
test('Forged, expired, path-replayed or untrusted forwarded identities fail closed', async (t) => {
  const rate = guard(t);
  for (const request of [
    context({ 'x-raui-client-ip': '8.8.8.8' }),
    context({
      ...signed('8.8.8.8'),
      'x-raui-forwarded-signature': '0'.repeat(64),
    }),
    context(signed('8.8.8.8', 'POST', '/v1/search', Date.now() - 60000)),
    context(signed('8.8.8.8'), '127.0.0.1', 'GET'),
    context(signed('8.8.8.8'), '127.0.0.1', 'POST', '/v1/search?changed=1'),
    context(signed('8.8.8.8'), '8.8.4.4'),
  ])
    await assert.rejects(
      rate.canActivate(request),
      /Forwarded identity rejected/,
    );
});
