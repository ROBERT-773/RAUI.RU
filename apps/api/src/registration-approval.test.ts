import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SessionGuard } from './common/security';
import { AuthService } from './modules/auth/auth';
import type { Database } from './modules/database/database';
import type { Audit } from './modules/audit/audit';
import type { Reflector } from '@nestjs/core';

for (const state of ['pending', 'rejected']) {
  test(`${state} bearer session cannot read private collections`, async () => {
    const db = {
      rows: async () => [
        { id: 'u', role: 'buyer', registration_approval_state: state },
      ],
    };
    const guard = new SessionGuard(
      db as unknown as Database,
      { getAllAndOverride: () => undefined } as unknown as Reflector,
    );
    const req = {
      url: '/v1/account/collections/favorite',
      method: 'GET',
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    await assert.rejects(
      guard.canActivate(context as never),
      ForbiddenException,
    );
  });
}
test('pending bearer session can read onboarding profile', async () => {
  const guard = new SessionGuard(
    {
      rows: async () => [{ registration_approval_state: 'pending' }],
    } as unknown as Database,
    { getAllAndOverride: () => undefined } as unknown as Reflector,
  );
  const req = {
    url: '/v1/auth/me',
    method: 'GET',
    headers: { authorization: `Bearer ${'a'.repeat(43)}` },
  };
  assert.equal(
    await guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as never),
    true,
  );
});
test('registration reports created account when provider is unavailable', async () => {
  const user = {
    id: 'u',
    email: 'new@example.test',
    registration_approval_state: 'pending',
  };
  const db = {
    rows: async () => [user],
    transaction: async (work: (sql: unknown) => unknown) =>
      work({ query: async () => ({ rows: [] }) }),
  };
  const auth = new AuthService(
    db as unknown as Database,
    { record: async () => {} } as unknown as Audit,
    {
      send: async () => {
        throw new ServiceUnavailableException('private provider details');
      },
    },
  );
  const result = await auth.register({
    email: user.email,
    password: 'password-long-enough',
    displayName: 'New user',
  });
  assert.equal(result.verificationDelivery, 'unavailable');
  assert.equal(result.registration_approval_state, 'pending');
  assert.equal(JSON.stringify(result).includes('private provider'), false);
});

test('registration queue rejects malformed cursors before querying contacts', async () => {
  const { RegistrationApprovals } =
    await import('./modules/admin/registration-approval.js');
  const service = new RegistrationApprovals(
    {
      rows: async () => {
        throw new Error('unexpected contact query');
      },
    } as unknown as Database,
    {} as Audit,
    {} as never,
  );
  await assert.rejects(service.queue('invalid'), { status: 400 });
});

test('registration does not hide programming errors as delivery outages', async () => {
  const db = {
    rows: async () => [{ id: 'u', email: 'new@example.test' }],
    transaction: async (work: (sql: unknown) => unknown) =>
      work({ query: async () => ({ rows: [] }) }),
  };
  const auth = new AuthService(
    db as unknown as Database,
    { record: async () => {} } as unknown as Audit,
    {
      send: async () => {
        throw new TypeError('programming failure');
      },
    },
  );
  await assert.rejects(
    auth.register({
      email: 'new@example.test',
      password: 'password-long-enough',
      displayName: 'New user',
    }),
    TypeError,
  );
});

test('decision replay requires a fresh approved staff actor', async () => {
  const { RegistrationApprovals } =
    await import('./modules/admin/registration-approval.js');
  const { Idempotency } = await import('./common/security.js');
  const db = {
    transaction: async (work: (sql: unknown) => unknown) =>
      work({ query: async () => ({ rows: [] }) }),
    rows: async (query: string) =>
      query.includes('FROM users')
        ? [
            {
              id: 'staff',
              active: false,
              registration_approval_state: 'approved',
            },
          ]
        : [{ request_hash: '', response: { state: 'approved' } }],
  };
  const service = new RegistrationApprovals(
    db as unknown as Database,
    {} as Audit,
    new Idempotency(db as unknown as Database),
  );
  await assert.rejects(
    service.decision(
      {
        id: 'staff',
        role: 'admin',
        session_id: 's',
        email_verified_at: 'yes',
        phone_verified_at: 'yes',
      },
      '00000000-0000-4000-8000-000000000001',
      { decision: 'approve', reason: 'verified applicant' },
      'replay-key-123',
    ),
    ForbiddenException,
  );
});

for (const [method, url, allowed] of [
  ['GET', '/v1/auth/verification/phone/capabilities', true],
  ['POST', '/v1/auth/verification/phone/otp', true],
  ['POST', '/v1/auth/verification/phone/otp/confirm', true],
  ['GET', '/v1/auth/verification/phone/otp', false],
  ['POST', '/v1/auth/verification/phone/capabilities', false],
  ['GET', '/v1/auth/verification/phone/otp/confirm', false],
  ['POST', '/v1/auth/verification/phone/otp/confirm/extra', false],
  ['POST', '/v1/auth/verification/phone/otp/', false],
] as const) {
  test(`pending OTP onboarding method boundary: ${method} ${url}`, async () => {
    const guard = new SessionGuard(
      {
        rows: async () => [{ registration_approval_state: 'pending' }],
      } as unknown as Database,
      { getAllAndOverride: () => undefined } as unknown as Reflector,
    );
    const req = {
      url,
      method,
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    if (allowed) assert.equal(await guard.canActivate(context as never), true);
    else
      await assert.rejects(
        guard.canActivate(context as never),
        ForbiddenException,
      );
  });
}
