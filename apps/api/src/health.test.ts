import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { Dependencies } from './dependencies';
import { envSchema } from './config';
const validEnv = {
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://localhost/raui',
  REDIS_URL: 'redis://localhost:6379',
};
test('config supplies defaults for valid local connections', () => {
  const result = envSchema.parse(validEnv);
  assert.equal(result.API_PORT, 3001);
  assert.equal(result.NODE_ENV, 'development');
});
test('config rejects invalid fields independently', () => {
  for (const patch of [
    { API_PORT: 0 },
    { API_PORT: 65536 },
    { API_PORT: 'invalid' },
    { WEB_ORIGIN: 'invalid' },
    { NODE_ENV: 'unknown' },
    { DATABASE_URL: 'https://example.com' },
    { REDIS_URL: 'http://example.com' },
  ]) {
    assert.equal(envSchema.safeParse({ ...validEnv, ...patch }).success, false);
  }
  assert.equal(envSchema.safeParse({}).success, false);
});
test('Nest HTTP routes expose liveness, readiness and 503 failure', async () => {
  let fails = false;
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: Dependencies,
        useValue: {
          check: async () => {
            if (fails) throw new Error('offline');
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  try {
    const url = await app.getUrl();
    const live = await fetch(`${url}/health`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok', service: 'api' });
    assert.equal((await fetch(`${url}/health/ready`)).status, 200);
    fails = true;
    assert.equal((await fetch(`${url}/health/ready`)).status, 503);
  } finally {
    await app.close();
  }
});
test('readiness propagates service unavailable without leaking details', async () => {
  const controller = new HealthController({
    check: async () => {
      throw new Error('secret');
    },
  } as unknown as Dependencies);
  await assert.rejects(controller.ready(), ServiceUnavailableException);
});
