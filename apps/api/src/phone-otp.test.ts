import nativeHttps from 'node:https';
import nativeDns from 'node:dns/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  envSchema,
  phoneOtpCapability,
  validPhoneOtpPepper,
  validPhoneOtpUrl,
} from './config';
import {
  ConfiguredPhoneOtpDelivery,
  classifyPhoneOtpAcknowledgment,
  resolvePhoneOtpGateway,
} from './modules/auth/phone-otp-delivery';
import {
  phoneOtpKeySchema,
  phoneOtpConfirmSchema,
  phoneOtpDigest,
  phoneOtpDestinationDigest,
} from './modules/auth/phone-otp';
const testOnlyPepper = randomBytes(32).toString('base64url');
test('OTP defaults disabled and incomplete bindings do not expose secrets or stop startup', () => {
  const base = {
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
  };
  assert.equal(envSchema.parse(base).PHONE_OTP_ENABLED, 'false');
  assert.deepEqual(phoneOtpCapability(envSchema.parse(base)), {
    available: false,
    reason: 'disabled',
  });
  assert.deepEqual(
    phoneOtpCapability(envSchema.parse({ ...base, PHONE_OTP_ENABLED: 'true' })),
    { available: false, reason: 'unconfigured' },
  );
  const cfg = envSchema.parse({
    ...base,
    PHONE_OTP_ENABLED: 'true',
    PHONE_OTP_PEPPER: testOnlyPepper,
    PHONE_OTP_GATEWAY_URL: 'https://sms.example.test/dispatch',
    PHONE_OTP_GATEWAY_TOKEN: 'test-only-gateway-token',
  });
  assert.deepEqual(phoneOtpCapability(cfg), {
    available: true,
    reason: 'available',
  });
  assert.equal(
    JSON.stringify(phoneOtpCapability(cfg)).includes(testOnlyPepper),
    false,
  );
});
test('OTP rejects malformed pepper and unsafe URL bindings', () => {
  assert.equal(validPhoneOtpPepper(testOnlyPepper), true);
  for (const pepper of ['abc', testOnlyPepper + '=', 'a'.repeat(43)])
    assert.equal(validPhoneOtpPepper(pepper), false);
  for (const url of [
    'http://sms.example.test',
    'https://u:p@sms.example.test',
    'https://127.0.0.1',
    'https://sms.example.test:444',
    'https://sms.example.test?a=1',
    'https://sms.example.test/#code',
  ])
    assert.equal(validPhoneOtpUrl(url), false);
});
test('OTP exact acknowledgment and failure classes are bounded', () => {
  const body = JSON.stringify({
    version: 1,
    challengeId: 'test-id',
    accepted: true,
  });
  assert.equal(
    classifyPhoneOtpAcknowledgment(202, body, 'test-id'),
    'accepted',
  );
  for (const status of [200, 201, 204, 301, 408, 500, 503])
    assert.equal(
      classifyPhoneOtpAcknowledgment(status, body, 'test-id'),
      'unknown',
    );
  for (const status of [400, 401, 403, 429])
    assert.equal(
      classifyPhoneOtpAcknowledgment(
        status,
        'private provider text',
        'test-id',
      ),
      'unavailable',
    );
  for (const invalid of [
    '{',
    body + ' ',
    JSON.stringify({ version: 1, challengeId: 'other', accepted: true }),
    JSON.stringify({
      version: 1,
      challengeId: 'test-id',
      accepted: true,
      code: '000123',
    }),
    ' '.repeat(4097),
  ]) {
    if (invalid === body + ' ') continue;
    assert.equal(
      classifyPhoneOtpAcknowledgment(202, invalid, 'test-id'),
      'unknown',
    );
  }
});
test('OTP DNS rejects any private or mixed address and pins eligible public IPv4', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    resolvePhoneOtpGateway('sms.example.test', resolver as never),
    /rejected/,
  );
  await assert.rejects(
    resolvePhoneOtpGateway('sms.example.test', (async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]) as never),
    /rejected/,
  );
  assert.deepEqual(
    await resolvePhoneOtpGateway('sms.example.test', (async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as never),
    { address: '93.184.216.34', family: 4 },
  );
});
test('OTP HMAC binds every dimension and isolates destination domain; six-digit text preserves zeros', () => {
  const pepper = Buffer.from(testOnlyPepper, 'base64url');
  const digest = phoneOtpDigest(pepper, 'id', 'user', '+79990000001', '000123');
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const tuple of [
    ['other', 'user', '+79990000001', '000123'],
    ['id', 'other', '+79990000001', '000123'],
    ['id', 'user', '+79990000002', '000123'],
    ['id', 'user', '+79990000001', '123000'],
  ])
    assert.notEqual(
      phoneOtpDigest(pepper, ...(tuple as [string, string, string, string])),
      digest,
    );
  assert.notEqual(phoneOtpDestinationDigest(pepper, '+79990000001'), digest);
  const challengeId = 'c1a49191-67be-498f-acad-2457d4ef13b1';
  assert.equal(
    phoneOtpConfirmSchema.parse({ challengeId, code: '000123' }).code,
    '000123',
  );
  for (const code of [123, '123', '1234567', ' 123456', '１２３４５６'])
    assert.equal(
      phoneOtpConfirmSchema.safeParse({ challengeId, code }).success,
      false,
    );
});

test('OTP request keys obey strict8–100 contract without normalization', () => {
  for (const key of ['a'.repeat(8), 'a'.repeat(100), 'abc_def-123'])
    assert.equal(phoneOtpKeySchema.safeParse(key).success, true);
  for (const key of [
    'a'.repeat(7),
    'a'.repeat(101),
    'abcdefgh:',
    'abcdefgh.',
    ' abcdefgh',
    'abcdefgh ',
  ])
    assert.equal(phoneOtpKeySchema.safeParse(key).success, false);
});

test('configured OTP adapter assembles pinned TLS request, bounded acknowledgment and never follows redirects', async (t) => {
  const { EventEmitter } = await import('node:events');
  const previous = { ...process.env };
  Object.assign(process.env, {
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
    PHONE_OTP_ENABLED: 'true',
    PHONE_OTP_PEPPER: testOnlyPepper,
    PHONE_OTP_GATEWAY_URL: 'https://sms.example.test/dispatch',
    PHONE_OTP_GATEWAY_TOKEN: 'test-only-gateway-token',
  });
  t.after(() => {
    process.env = previous;
  });
  // Native module exports are mutable at their CommonJS boundary used by the compiled service.
  t.mock.method(nativeDns, 'lookup', async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
  const message = {
    version: 1 as const,
    challengeId: 'test-challenge',
    destination: '+79990000001',
    code: '000123',
    expiresAt: '2026-10-08T12:05:00.000Z',
  };
  let status = 202,
    payload = JSON.stringify({
      version: 1,
      challengeId: message.challengeId,
      accepted: true,
    }),
    wireCalls = 0;
  const outputs: string[] = [];
  t.mock.method(nativeHttps, 'request', ((
    _url: URL,
    options: import('node:https').RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    wireCalls++;
    assert.equal(_url.href, 'https://sms.example.test/dispatch');
    assert.equal(options.method, 'POST');
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, 'sms.example.test');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(options.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-only-gateway-token',
      'Idempotency-Key': 'test-challenge',
    });
    const socket = new EventEmitter() as import('node:http').ClientRequest;
    socket.end = ((body: string) => {
      outputs.push(body);
      const response =
        new EventEmitter() as import('node:http').IncomingMessage;
      response.statusCode = status;
      response.destroy = (() => response) as typeof response.destroy;
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(payload));
        response.emit('end');
      });
      return socket;
    }) as typeof socket.end;
    return socket;
  }) as typeof nativeHttps.request);
  const adapter = new ConfiguredPhoneOtpDelivery();
  assert.equal(await adapter.send(message), 'accepted');
  assert.deepEqual(JSON.parse(outputs[0]!), message);
  assert.equal(outputs[0]!.includes('gateway-token'), false);
  status = 301;
  assert.equal(await adapter.send(message), 'unknown');
  assert.equal(wireCalls, 2); // Exactly one request each; no redirect or retry.
  status = 202;
  payload = ' '.repeat(4097);
  assert.equal(await adapter.send(message), 'unknown');
  payload = JSON.stringify({
    version: 1,
    challengeId: 'mismatch',
    accepted: true,
  });
  assert.equal(await adapter.send(message), 'unknown');
  status = 403;
  payload = 'secret-provider-error000123';
  assert.equal(await adapter.send(message), 'unavailable');
  assert.equal(wireCalls, 5);
});

test('configured OTP adapter times out a stalled controlled socket and rejects private DNS before request', async (t) => {
  const { EventEmitter } = await import('node:events');
  const previous = { ...process.env };
  Object.assign(process.env, {
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
    PHONE_OTP_ENABLED: 'true',
    PHONE_OTP_PEPPER: testOnlyPepper,
    PHONE_OTP_GATEWAY_URL: 'https://sms.example.test/dispatch',
    PHONE_OTP_GATEWAY_TOKEN: 'test-only-gateway-token',
  });
  t.after(() => {
    process.env = previous;
  });
  let address = '93.184.216.34',
    calls = 0;
  t.mock.method(nativeDns, 'lookup', async () => [{ address, family: 4 }]);
  t.mock.method(nativeHttps, 'request', ((
    _url: URL,
    options: import('node:https').RequestOptions,
  ) => {
    calls++;
    const socket = new EventEmitter() as import('node:http').ClientRequest;
    socket.end = (() => socket) as typeof socket.end;
    options.signal!.addEventListener(
      'abort',
      () => socket.emit('error', new Error('sensitive provider error')),
      { once: true },
    );
    return socket;
  }) as typeof nativeHttps.request);
  const message = {
    version: 1 as const,
    challengeId: 'timeout',
    destination: '+79990000001',
    code: '000123',
    expiresAt: '2026-10-08T12:05:00.000Z',
  };
  const keepAlive = setTimeout(() => {}, 6000);
  try {
    const start = performance.now();
    assert.equal(
      await new ConfiguredPhoneOtpDelivery().send(message),
      'unknown',
    );
    assert.ok(performance.now() - start >= 4900);
    assert.ok(performance.now() - start < 5900);
  } finally {
    clearTimeout(keepAlive);
  }
  address = '10.0.0.1';
  assert.equal(await new ConfiguredPhoneOtpDelivery().send(message), 'unknown');
  assert.equal(calls, 1);
});
