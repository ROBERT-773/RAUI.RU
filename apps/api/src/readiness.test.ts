import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArgumentsHost } from '@nestjs/common';
import { ApiErrors } from './common/http';
import { envSchema } from './config';
import { ConfiguredMediaDelivery } from './modules/media/storage';
const production = {
  NODE_ENV: 'production',
  PROXY_IDENTITY_SECRET: 'synthetic-forwarding-key-'.repeat(2),
  TRUSTED_PROXY_PEERS: '127.0.0.1',
  TRUSTED_INGRESS_IP_HEADER: 'x-real-ip',
  WEB_ORIGIN: 'https://raui.ru',
  SITE_URL: 'https://raui.ru',
  DATABASE_URL: 'postgresql://service@db.internal/raui?sslmode=verify-full',
  REDIS_URL: 'rediss://redis.internal:6380',
  OPENSEARCH_URL: 'https://search.internal:9200',
  OPENSEARCH_TOKEN: 'test-only-search-token',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'raui-private',
  S3_ENDPOINT: 'https://storage.internal',
  VERIFICATION_GATEWAY_URL: 'https://verification.example/generate',
  VERIFICATION_GATEWAY_TOKEN: 'test-only-verification-token',
};
test('Production contracts require verified DB TLS, Redis TLS and matching clean public HTTPS origins', () => {
  assert.ok(envSchema.safeParse(production).success);
  for (const fields of [
    { WEB_ORIGIN: 'http://raui.ru' },
    { PROXY_IDENTITY_SECRET: undefined },
    { TRUSTED_PROXY_PEERS: '' },
    { TRUSTED_PROXY_PEERS: 'any' },
    { TRUSTED_INGRESS_IP_HEADER: undefined },
    { WEB_ORIGIN: 'https://user:secret@raui.ru' },
    { WEB_ORIGIN: 'https://raui.ru/path' },
    { WEB_ORIGIN: 'https://raui.ru?secret=value' },
    { SITE_URL: 'http://raui.ru' },
    { SITE_URL: 'https://other.example' },
    { SITE_URL: undefined },
    { DATABASE_URL: 'postgresql://service@db.internal/raui' },
    { DATABASE_URL: 'postgresql://service@db.internal/raui?sslmode=require' },
    {
      DATABASE_URL:
        'postgresql://service@db.internal/raui?sslmode=verify-full&sslmode=disable',
    },
    {
      DATABASE_URL:
        'postgresql://service@db.internal/raui?sslmode=verify-full&ssl=false',
    },
    { REDIS_URL: 'redis://redis.internal:6379' },
    { OPENSEARCH_TOKEN: undefined },
    { CDN_BASE_URL: 'http://cdn.raui.ru' },
  ])
    assert.equal(
      envSchema.safeParse({ ...production, ...fields }).success,
      false,
      JSON.stringify(Object.keys(fields)),
    );
});
test('Local development retains explicit loopback adapters without enabling production defaults', () => {
  const config = envSchema.parse({
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://localhost/raui',
    REDIS_URL: 'redis://localhost:6379',
  });
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.AI_ENABLED, 'false');
  assert.equal(config.STORAGE_DRIVER, 'local');
});

test('Malformed configuration URLs fail validation without throwing raw credential-bearing URL errors', () => {
  for (const field of [
    'WEB_ORIGIN',
    'SITE_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'OPENSEARCH_URL',
    'S3_ENDPOINT',
    'CDN_BASE_URL',
    'AI_GATEWAY_URL',
    'NOTIFICATION_GATEWAY_URL',
    'VERIFICATION_GATEWAY_URL',
    'GEOCODER_URL',
  ]) {
    assert.doesNotThrow(() => {
      assert.equal(
        envSchema.safeParse({ ...production, [field]: 'https://test-secret@[' })
          .success,
        false,
      );
    }, field);
  }
});

test('HTTP failures tolerate null errors and never log unknown private error codes or payloads', (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) =>
    logs.push(values.map(String).join(' ')),
  );
  for (const error of [
    null,
    undefined,
    { code: 'PRIVATE_TOKEN_VALUE', message: 'private-contact@example.test' },
    new Error('provider-secret'),
  ]) {
    let status = 0,
      body: unknown;
    const response = {
      status(value: number) {
        status = value;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({}),
      }),
    } as unknown as ArgumentsHost;
    assert.doesNotThrow(() => new ApiErrors().catch(error, host));
    assert.equal(status, 500);
    assert.deepEqual(body, { message: 'Internal server error' });
  }
  assert.equal(logs.length, 4);
  assert.ok(
    logs.every(
      (value) =>
        value === JSON.stringify({ event: 'request_error', code: 'internal' }),
    ),
  );
});

test('CDN media bases reject query, fragment and credentials while preserving path prefixes', () => {
  const development = {
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://localhost/raui',
    REDIS_URL: 'redis://localhost:6379',
  };
  for (const config of [production, development]) {
    for (const base of [
      'https://cdn.raui.ru?x=1',
      'https://cdn.raui.ru#fragment',
      'https://user:password@cdn.raui.ru',
      'data:text/plain,fixture',
    ])
      assert.equal(
        envSchema.safeParse({ ...config, CDN_BASE_URL: base }).success,
        false,
      );
    for (const base of [
      'https://cdn.raui.ru',
      'https://cdn.raui.ru/',
      'https://cdn.raui.ru/prefix/',
    ])
      assert.equal(
        envSchema.safeParse({ ...config, CDN_BASE_URL: base }).success,
        true,
      );
  }
  const fields = [
    'NODE_ENV',
    'WEB_ORIGIN',
    'DATABASE_URL',
    'REDIS_URL',
    'CDN_BASE_URL',
  ] as const;
  const before = Object.fromEntries(
    fields.map((field) => [field, process.env[field]]),
  );
  try {
    Object.assign(process.env, development);
    const delivery = new ConfiguredMediaDelivery();
    for (const [base, expected] of [
      [undefined, '/v1/media/fixture/thumb'],
      ['https://cdn.raui.ru', 'https://cdn.raui.ru/v1/media/fixture/thumb'],
      ['https://cdn.raui.ru/', 'https://cdn.raui.ru/v1/media/fixture/thumb'],
      [
        'https://cdn.raui.ru/prefix/',
        'https://cdn.raui.ru/prefix/v1/media/fixture/thumb',
      ],
    ] as const) {
      if (base === undefined) delete process.env.CDN_BASE_URL;
      else process.env.CDN_BASE_URL = base;
      assert.equal(delivery.url('fixture', 'thumb'), expected);
    }
  } finally {
    for (const field of fields) {
      if (before[field] === undefined) delete process.env[field];
      else process.env[field] = before[field];
    }
  }
});
