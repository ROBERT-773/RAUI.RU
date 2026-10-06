import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import * as config from './config';
import { BadRequestException } from '@nestjs/common';
import { ProfessionalImports } from './modules/professional/imports';
import { ConfiguredDelivery } from './modules/auth/delivery';
import {
  publicIPv4,
  validateFeedUrl,
  resolveFeedHost,
  HttpsFeedFetcher,
} from './modules/professional/feed-fetch';
import { parseFeed } from './modules/professional/feed-parser';
import {
  GatewayNotificationAdapter,
  validateNotificationGatewayUrl,
  resolveNotificationGatewayHost,
} from './modules/professional/notifications';
import {
  importItem,
  cadence,
  nextDue,
  normalizedFingerprint,
} from './modules/professional/contracts';
test('Missing import items fail validation before authorization or persistence', async () => {
  const imports = new ProfessionalImports(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    imports.apply({} as never, 'invalid', 'invalid', {}, 'test-key'),
    BadRequestException,
  );
});
test('Feed SSRF policy rejects private, reserved, link-local, IPv6 and secret-bearing URLs', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.31.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
  assert.equal(
    validateFeedUrl('https://feeds.example/listings', ['feeds.example'])
      .hostname,
    'feeds.example',
  );
  for (const url of [
    'http://feeds.example',
    'https://feeds.example.attacker.test',
    'https://user:secret@feeds.example',
    'https://feeds.example:8443',
    'https://127.0.0.1',
  ])
    assert.throws(() => validateFeedUrl(url, ['feeds.example']));
});
test('JSON, bounded CSV and entity-free XML decode into normalized mapped feeds', () => {
  const map = {
    externalReference: 'ref',
    title: 'name',
    price: 'price',
    dealType: 'deal',
    categoryCode: 'category',
    'address.formatted': 'address',
    'address.locality': 'locality',
    'address.longitude': 'lon',
    'address.latitude': 'lat',
    'attributes.area': 'area',
  };
  const row = {
    ref: '1',
    name: 'Flat',
    price: '100',
    deal: 'sale',
    category: 'apartment',
    address: 'Test address',
    locality: 'Москва',
    lon: '37.6',
    lat: '55.7',
    area: '50',
  };
  const json = parseFeed(JSON.stringify([row]), 'json', map);
  assert.equal(importItem.safeParse(json[0]).success, true);
  const csv = parseFeed(
    Object.keys(row).join(',') + '\n' + Object.values(row).join(','),
    'csv',
    map,
  );
  assert.deepEqual(csv, json);
  const xml = parseFeed(
    '<feed><item>' +
      Object.entries(row)
        .map(([k, v]) => `<${k}>${v}</${k}>`)
        .join('') +
      '</item></feed>',
    'xml',
    map,
  );
  assert.deepEqual(xml, json);
  assert.throws(() =>
    parseFeed(
      '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed/>',
      'xml',
      {},
    ),
  );
  assert.throws(() => parseFeed('[{}]', 'json', { '__proto__.p': 'x' }));
  assert.throws(() => parseFeed('x'.repeat(2_000_001), 'json', {}));
});
test('Only supported UTC schedules and safe normalized fields are accepted', () => {
  assert.equal(cadence('*/15 * * * *'), 15);
  assert.equal(cadence('0 * * * *'), 60);
  assert.equal(cadence('0 0 * * *'), 1440);
  assert.equal(
    nextDue('*/15 * * * *', new Date('2026-10-05T09:07:16Z')).toISOString(),
    '2026-10-05T09:15:00.000Z',
  );
  assert.equal(
    nextDue('0 0 * * *', new Date('2026-10-05T09:07:16Z')).toISOString(),
    '2026-10-06T00:00:00.000Z',
  );
  assert.throws(() => cadence('* * * * *'));
  assert.throws(() => cadence('*/7 * * * *'));
  assert.equal(
    importItem.safeParse({ price: -1, status: 'published' }).success,
    false,
  );
});

test('Import fingerprints ignore JSON key ordering but preserve changed values', () => {
  assert.equal(
    normalizedFingerprint({ a: 1, attributes: { area: 50, x: true } }),
    normalizedFingerprint({ attributes: { x: true, area: 50 }, a: 1 }),
  );
  assert.notEqual(
    normalizedFingerprint({ a: 1 }),
    normalizedFingerprint({ a: 2 }),
  );
});

test('Feed DNS deadline and mixed private/public DNS answers fail closed', async () => {
  await assert.rejects(
    resolveFeedHost('feeds.example', async () => new Promise(() => {}), 10),
    /Feed DNS deadline/,
  );
  await assert.rejects(
    resolveFeedHost('feeds.example', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /Feed address rejected/,
  );
  const addresses = await resolveFeedHost('feeds.example', async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(addresses[0]!.address, '8.8.8.8');
});

test('Feed transport pins validated IPv4 with Node24-compatible TLS and rejects redirects', async (t) => {
  const previous = process.env.FEED_ALLOWED_HOSTS;
  process.env.FEED_ALLOWED_HOSTS = 'feeds.example';
  t.after(() => {
    if (previous === undefined) delete process.env.FEED_ALLOWED_HOSTS;
    else process.env.FEED_ALLOWED_HOSTS = previous;
  });
  let dnsCalls = 0,
    requests = 0,
    statusCode = 200;
  t.mock.method(dns, 'lookup', async () => {
    dnsCalls++;
    return [{ address: dnsCalls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  });
  let captured: https.RequestOptions | undefined;
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    requests++;
    captured = options;
    assert.equal(url.hostname, 'feeds.example');
    const req = new EventEmitter();
    return Object.assign(req, {
      destroy() {},
      end() {
        // Node24 autoSelectFamily requests all:true unless the adapter pins IPv4.
        options.lookup!(
          'feeds.example',
          { all: options.family !== 4 },
          (_error, address) => {
            if (options.family !== 4 && !Array.isArray(address)) {
              req.emit(
                'error',
                new Error('Node24 lookup expected address objects'),
              );
              return;
            }
            assert.equal(address, '8.8.8.8');
            const res = Object.assign(new EventEmitter(), {
              statusCode,
              headers: { 'content-type': 'application/json' },
            });
            callback(res);
            if (statusCode === 200) {
              res.emit('data', Buffer.from('[]'));
              res.emit('end');
            }
          },
        );
      },
    });
  }) as never);
  const fetcher = new HttpsFeedFetcher();
  assert.equal(await fetcher.fetch('https://feeds.example/listings'), '[]');
  assert.equal(captured?.family, 4);
  assert.equal(captured?.servername, 'feeds.example');
  assert.equal(captured?.rejectUnauthorized, true);
  assert.equal(captured?.agent, false);
  assert.equal(dnsCalls, 1);
  await assert.rejects(
    fetcher.fetch('https://feeds.example/listings'),
    /Feed address rejected/,
  );
  assert.equal(requests, 1);
  dnsCalls = 0;
  statusCode = 302;
  await assert.rejects(
    fetcher.fetch('https://feeds.example/listings'),
    /Feed response rejected/,
  );
  assert.equal(requests, 2);
});

test('Verification challenge delivery refuses redirects and sanitizes transport failures', async (t) => {
  t.mock.method(config, 'loadConfig', () =>
    config.envSchema.parse({
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      VERIFICATION_GATEWAY_URL: 'https://verify.example/send',
      VERIFICATION_GATEWAY_TOKEN: 'test-only-provider-token',
    }),
  );
  const message = {
    destination: 'fixture@example.test',
    purpose: 'reset' as const,
    token: 'synthetic-private-challenge',
  };
  let forwarded = 0,
    status = 307;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/send') {
      response.writeHead(status, { Location: '/unapproved-destination' });
      response.end();
    } else {
      forwarded++;
      response.writeHead(204);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const port = (server.address() as { port: number }).port;
  const nativeFetch = globalThis.fetch;
  // Only the configured HTTPS transport destination is mapped to a controlled
  // loopback fixture; native fetch still executes the actual redirect policy.
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    assert.equal(url, 'https://verify.example/send');
    return nativeFetch(`http://127.0.0.1:${port}/send`, init);
  });
  const delivery = new ConfiguredDelivery();
  for (status of [307, 308]) {
    await assert.rejects(
      delivery.send(message),
      /Verification delivery unavailable/,
    );
    assert.equal(forwarded, 0);
  }
});

test('Notification gateway rejects unsafe destinations and DNS rebinding answers', async () => {
  assert.equal(
    validateNotificationGatewayUrl('https://notify.example/v1/send').hostname,
    'notify.example',
  );
  for (const url of [
    'http://notify.example/v1/send',
    'https://user:secret@notify.example/v1/send',
    'https://notify.example:8443/v1/send',
    'https://127.0.0.1/v1/send',
    'https://[::1]/v1/send',
  ])
    assert.throws(
      () => validateNotificationGatewayUrl(url),
      /notification_gateway_rejected/,
      url,
    );

  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '203.0.113.1',
    '::1',
  ])
    await assert.rejects(
      resolveNotificationGatewayHost('notify.example', async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]),
      /notification_gateway_address_rejected/,
    );

  await assert.rejects(
    resolveNotificationGatewayHost('notify.example', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /notification_gateway_address_rejected/,
  );
  const selected = await resolveNotificationGatewayHost(
    'notify.example',
    async () => [{ address: '8.8.8.8', family: 4 }],
  );
  assert.equal(selected.address, '8.8.8.8');
});

test('Notification transport pins validated DNS, preserves TLS hostname and rejects redirects', async (t) => {
  t.mock.method(config, 'loadConfig', () =>
    config.envSchema.parse({
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      NOTIFICATION_GATEWAY_URL: 'https://notify.example/v1/send',
      NOTIFICATION_GATEWAY_TOKEN: 'test-only-gateway-token',
    }),
  );
  let resolutions = 0;
  t.mock.method(dns, 'lookup', async () => {
    resolutions++;
    return [
      { address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
    ];
  });
  let statusCode = 204;
  let requests = 0;
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: (response: { statusCode: number; destroy(): void }) => void,
  ) => {
    requests++;
    assert.equal(url.hostname, 'notify.example');
    assert.equal(options.servername, 'notify.example');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.family, 4);
    assert.equal(options.signal, signal);
    assert.equal(
      (options.headers as Record<string, string>)['Idempotency-Key'],
      input.idempotencyKey,
    );
    assert.equal(typeof options.lookup, 'function');
    // A second DNS query would rebind to loopback; the transport must use the validated snapshot.
    options.lookup!('notify.example', {}, (_error, address, family) => {
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    return Object.assign(request, {
      end: (body: string) => {
        assert.deepEqual(JSON.parse(body), input);
        callback({ statusCode, destroy() {} });
      },
    });
  }) as never);
  const signal = new AbortController().signal;
  const input = {
    channel: 'email' as const,
    userId: 'test-user',
    kind: 'message',
    payload: {},
    idempotencyKey: 'notification:test',
    destination: 'test@example.com',
  };
  const adapter = new GatewayNotificationAdapter();
  await adapter.send(input, signal);
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);
  // A new delivery must revalidate DNS and reject the changed answer before opening a socket.
  await assert.rejects(
    adapter.send(input, signal),
    /notification_gateway_address_rejected/,
  );
  assert.equal(requests, 1);
  resolutions = 0;
  statusCode = 302;
  await assert.rejects(adapter.send(input, signal), /delivery_failed/);
  assert.equal(requests, 2);
});
