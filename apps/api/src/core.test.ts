import { test } from 'node:test';
import { Geo, addressSchema } from './modules/geo/geo';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { passwordHash, passwordMatches } from './common/security';
import { assertTransition } from './modules/listings/listings';
import { validateAttributes } from './modules/catalog/catalog';
import { validateImage } from './modules/media/media';
import { envSchema } from './config';
import sharp from 'sharp';
import { enrichOpenApi } from './common/openapi';
import type { OpenAPIObject } from '@nestjs/swagger';
import { migrate } from './modules/database/migrate';
import type { Pool } from 'pg';
import { Database } from './modules/database/database';
import { RegionCatalogue, loadRegionDocuments } from './modules/geo/regions';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthController,
  AuthService,
  registerSchema,
} from './modules/auth/auth';
import { VerificationDelivery } from './modules/auth/delivery';
import { PhoneOtpService } from './modules/auth/phone-otp';
import { Audit } from './modules/audit/audit';
import { Organizations } from './modules/organizations/organizations';
import { ProfessionalPlatform } from './modules/professional/platform';
import { Test } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';

test('organization offboarding does not depend on current user eligibility', async () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const memberId = '33333333-3333-4333-8333-333333333333';
  const writes: Array<{ text: string; values: unknown[] }> = [];
  const audits: Array<{
    sql: unknown;
    actor: string;
    action: string;
    type: string;
    id: string;
    data: unknown;
  }> = [];
  let membershipExists = true;
  let partnerClientsActive = true;
  const sql = {
    query: async (text: string, values: unknown[] = []) => {
      writes.push({ text, values });
      if (text.startsWith('UPDATE partner_clients SET active=false')) {
        assert.match(text, /organization_id=\$1/);
        assert.match(text, /created_by=\$2/);
        assert.match(text, /AND active/);
        assert.match(text, /RETURNING id/);
        if (!partnerClientsActive) return { rows: [] };
        partnerClientsActive = false;
        return {
          rows: [
            { id: '44444444-4444-4444-8444-444444444444' },
            { id: '55555555-5555-4555-8555-555555555555' },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const db = {
    pool: {},
    transaction: async <T>(work: (client: typeof sql) => Promise<T>) =>
      work(sql),
    rows: async (text: string) => {
      if (text.includes('SELECT kind FROM organizations'))
        return [{ kind: 'agency' }];
      if (
        text.includes('SELECT role FROM memberships WHERE organization_id') &&
        text.includes('AND active FOR SHARE')
      )
        return [{ role: 'owner' }];
      if (text.startsWith('SELECT role'))
        return membershipExists ? [{ role: 'member' }] : [];
      if (text.includes('SELECT id FROM users')) return [];
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const organizations = new Organizations(
    db as unknown as Database,
    {
      record: async (
        auditSql: unknown,
        auditActor: string,
        action: string,
        type: string,
        id: string,
        data: unknown,
      ) =>
        audits.push({
          sql: auditSql,
          actor: auditActor,
          action,
          type,
          id,
          data,
        }),
    } as unknown as Audit,
    {} as never,
  );
  const actor = {
    id: ownerId,
    role: 'agency' as const,
    email_verified_at: 'verified',
    phone_verified_at: 'verified',
    session_id: 'owner-session',
  };

  assert.deepEqual(
    await organizations.setMember(actor, organizationId, {
      userId: memberId,
      role: 'member',
      active: false,
    }),
    { userId: memberId, role: 'member', active: false },
  );
  assert.ok(
    writes.some(
      ({ text, values }) =>
        text.startsWith('UPDATE memberships SET active=false') &&
        values[0] === organizationId &&
        values[1] === memberId,
    ),
  );
  assert.equal(
    writes.some(({ text }) => text.startsWith('INSERT INTO memberships')),
    false,
  );
  assert.ok(
    writes.some(
      ({ text, values }) =>
        text.startsWith('UPDATE partner_clients SET active=false') &&
        values[0] === organizationId &&
        values[1] === memberId,
    ),
  );
  const partnerAudits = audits.filter(
    ({ action }) => action === 'partner.client.revoked',
  );
  assert.deepEqual(
    partnerAudits,
    [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ].map((id) => ({
      sql,
      actor: ownerId,
      action: 'partner.client.revoked',
      type: 'partner_client',
      id,
      data: {
        reason: 'membership_offboarded',
        organizationId,
        userId: memberId,
      },
    })),
  );
  await organizations.setMember(actor, organizationId, {
    userId: memberId,
    role: 'member',
    active: false,
  });
  assert.deepEqual(
    audits.filter(({ action }) => action === 'partner.client.revoked'),
    partnerAudits,
  );
  await assert.rejects(
    organizations.setMember(actor, organizationId, {
      userId: memberId,
      role: 'member',
      active: true,
    }),
    /Verified user required/,
  );
  membershipExists = false;
  const writesBeforeMissingMember = writes.length;
  await assert.rejects(
    organizations.setMember(actor, organizationId, {
      userId: memberId,
      role: 'member',
      active: false,
    }),
    /Membership required/,
  );
  assert.equal(writes.length, writesBeforeMissingMember + 1);
});

test('organization admin downgrade permanently revokes partner clients', async () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const adminId = '33333333-3333-4333-8333-333333333333';
  const writes: string[] = [];
  const audits: Array<{ action: string; data: unknown }> = [];
  const sql = {
    query: async (text: string) => {
      writes.push(text);
      if (text.startsWith('UPDATE partner_clients SET active=false'))
        return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
      return { rows: [] };
    },
  };
  const db = {
    pool: {},
    transaction: async <T>(work: (client: typeof sql) => Promise<T>) =>
      work(sql),
    rows: async (text: string) => {
      if (text.includes('SELECT kind FROM organizations'))
        return [{ kind: 'agency' }];
      if (text.includes('AND active FOR SHARE')) return [{ role: 'owner' }];
      if (
        text.startsWith('SELECT role,active FROM memberships') ||
        text.startsWith('SELECT role FROM memberships')
      )
        return [{ role: 'admin', active: true }];
      if (text.includes('SELECT id FROM users')) return [{ id: adminId }];
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const organizations = new Organizations(
    db as unknown as Database,
    {
      record: async (
        _sql: unknown,
        _actor: string,
        action: string,
        _type: string,
        _id: string,
        data: unknown,
      ) => audits.push({ action, data }),
    } as unknown as Audit,
    {} as never,
  );

  await organizations.setMember(
    {
      id: ownerId,
      role: 'agency',
      email_verified_at: 'verified',
      phone_verified_at: 'verified',
      session_id: 'owner-session',
    },
    organizationId,
    { userId: adminId, role: 'member', active: true },
  );
  assert.ok(
    writes.some((text) =>
      text.startsWith('UPDATE partner_clients SET active=false'),
    ),
  );
  assert.ok(
    audits.some(
      ({ action, data }) =>
        action === 'partner.client.revoked' &&
        JSON.stringify(data).includes('membership_privilege_removed'),
    ),
  );
});

test('locked organization permission acquires organization before membership', async () => {
  const queries: string[] = [];
  const db = {
    pool: {},
    rows: async (text: string) => {
      queries.push(text);
      if (text.includes('FROM organizations')) return [{ kind: 'agency' }];
      if (text.includes('FROM memberships')) return [{ role: 'owner' }];
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const organizations = new Organizations(
    db as unknown as Database,
    {} as Audit,
    {} as never,
  );

  assert.deepEqual(
    await organizations.permission(
      {
        id: '22222222-2222-4222-8222-222222222222',
        role: 'agency',
        email_verified_at: 'verified',
        phone_verified_at: 'verified',
        session_id: 'owner-session',
      },
      '11111111-1111-4111-8111-111111111111',
      true,
      {} as never,
    ),
    { kind: 'agency', role: 'owner' },
  );
  assert.equal(queries.length, 2);
  assert.match(queries[0]!, /FROM organizations/);
  assert.match(queries[0]!, /FOR SHARE/);
  assert.match(queries[1]!, /FROM memberships/);
  assert.match(queries[1]!, /FOR SHARE/);
});

test('autocommit organization permission keeps authorization in one statement', async () => {
  const queries: string[] = [];
  const pool = {};
  const db = {
    pool,
    rows: async (text: string) => {
      queries.push(text);
      if (text.includes('JOIN memberships'))
        return [{ kind: 'agency', role: 'owner' }];
      throw new Error('Authorization was split across autocommit statements');
    },
  };
  const organizations = new Organizations(
    db as unknown as Database,
    {} as Audit,
    {} as never,
  );

  await organizations.permission(
    {
      id: '22222222-2222-4222-8222-222222222222',
      role: 'agency',
      email_verified_at: 'verified',
      phone_verified_at: 'verified',
      session_id: 'owner-session',
    },
    '11111111-1111-4111-8111-111111111111',
    true,
  );
  assert.equal(queries.length, 1);
});

test('partner authentication locks organization and membership before client', async () => {
  const queries: string[] = [];
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const creatorId = '22222222-2222-4222-8222-222222222222';
  const clientId = '33333333-3333-4333-8333-333333333333';
  const sql = { query: async () => ({ rows: [] }) };
  const db = {
    transaction: async <T>(work: (client: typeof sql) => Promise<T>) =>
      work(sql),
    rows: async (text: string) => {
      queries.push(text);
      if (text.includes('FROM partner_clients WHERE token_digest'))
        return [
          {
            id: clientId,
            organization_id: organizationId,
            created_by: creatorId,
          },
        ];
      if (text.includes('FROM organizations')) return [{ id: organizationId }];
      if (text.includes('FROM memberships')) return [{ role: 'admin' }];
      if (text.includes('FROM partner_clients k JOIN users u'))
        return [
          {
            id: clientId,
            organization_id: organizationId,
            scopes: ['listings:read'],
            requests_per_minute: 10,
            created_by: creatorId,
          },
        ];
      if (text.includes('clock_timestamp()')) return [{ valid: true }];
      if (text.includes('INSERT INTO partner_client_usage'))
        return [{ count: 1 }];
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const platform = new ProfessionalPlatform(
    db as unknown as Database,
    {} as Organizations,
    {} as Audit,
    {} as never,
    {} as never,
  );

  assert.equal(
    (
      await platform.partner(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'listings:read',
      )
    ).id,
    clientId,
  );
  assert.match(queries[0]!, /FROM partner_clients WHERE token_digest/);
  assert.doesNotMatch(queries[0]!, /FOR UPDATE/);
  assert.match(queries[1]!, /FROM organizations/);
  assert.match(queries[1]!, /FOR SHARE/);
  assert.match(queries[2]!, /FROM memberships/);
  assert.match(queries[2]!, /FOR SHARE/);
  assert.match(queries[3]!, /FROM partner_clients k JOIN users u/);
  assert.match(queries[3]!, /FOR UPDATE OF k/);
});

test('partner authentication rejects expiry after client lock before usage', async () => {
  const queries: string[] = [];
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const creatorId = '22222222-2222-4222-8222-222222222222';
  const clientId = '33333333-3333-4333-8333-333333333333';
  const sql = { query: async () => ({ rows: [] }) };
  const db = {
    transaction: async <T>(work: (client: typeof sql) => Promise<T>) =>
      work(sql),
    rows: async (text: string) => {
      queries.push(text);
      if (text.includes('FROM partner_clients WHERE token_digest'))
        return [
          {
            id: clientId,
            organization_id: organizationId,
            created_by: creatorId,
          },
        ];
      if (text.includes('FROM organizations')) return [{ id: organizationId }];
      if (text.includes('FROM memberships')) return [{ role: 'admin' }];
      if (text.includes('FROM partner_clients k JOIN users u'))
        return [
          {
            id: clientId,
            organization_id: organizationId,
            scopes: ['listings:read'],
            requests_per_minute: 10,
            created_by: creatorId,
          },
        ];
      if (text.includes('clock_timestamp()')) return [{ valid: false }];
      if (text.includes('INSERT INTO partner_client_usage'))
        return [{ count: 1 }];
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const platform = new ProfessionalPlatform(
    db as unknown as Database,
    {} as Organizations,
    {} as Audit,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    platform.partner(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'listings:read',
    ),
    /Partner scope required/,
  );
  assert.equal(
    queries.some((query) => query.includes('INSERT INTO partner_client_usage')),
    false,
  );
  assert.match(queries[0]!, /FROM partner_clients WHERE token_digest/);
  assert.doesNotMatch(queries[0]!, /FOR UPDATE/);
  assert.match(queries[1]!, /FROM organizations/);
  assert.match(queries[1]!, /FOR SHARE/);
  assert.match(queries[2]!, /FROM memberships/);
  assert.match(queries[2]!, /FOR SHARE/);
  assert.match(queries[3]!, /FROM partner_clients k JOIN users u/);
  assert.match(queries[3]!, /FOR UPDATE OF k/);
});

test('partner revocation authorizes organization before locking client', async () => {
  const events: string[] = [];
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const clientId = '33333333-3333-4333-8333-333333333333';
  const sql = { query: async () => ({ rows: [] }) };
  const db = {
    transaction: async <T>(work: (client: typeof sql) => Promise<T>) =>
      work(sql),
    rows: async (text: string) => {
      if (text.includes('FROM partner_clients')) {
        events.push(
          text.includes('FOR UPDATE') ? 'client-lock' : 'client-read',
        );
        return [{ organization_id: organizationId, active: true }];
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const platform = new ProfessionalPlatform(
    db as unknown as Database,
    {
      permission: async () => {
        events.push('permission');
        return { kind: 'agency', role: 'owner' };
      },
    } as unknown as Organizations,
    { record: async () => {} } as unknown as Audit,
    {} as never,
    {} as never,
  );

  await platform.revoke(
    {
      id: '22222222-2222-4222-8222-222222222222',
      role: 'agency',
      email_verified_at: 'verified',
      phone_verified_at: 'verified',
      session_id: 'owner-session',
    },
    clientId,
    false,
    organizationId,
  );
  assert.deepEqual(events, ['client-read', 'permission', 'client-lock']);
});

test('password reset HTTP acceptance is identical for known and unknown accounts during delivery outage', async () => {
  const knownEmail = 'known-reset@example.test';
  const db = {
    rows: async (_sql: string, values: string[]) =>
      values[0] === knownEmail
        ? [{ id: 'fixture-user', email: knownEmail }]
        : [],
    transaction: async (work: (sql: unknown) => Promise<void>) =>
      work({ query: async () => ({ rows: [] }) }),
  };
  const module = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      AuthService,
      { provide: PhoneOtpService, useValue: {} },
      { provide: Database, useValue: db },
      { provide: Audit, useValue: { record: async () => {} } },
      {
        provide: VerificationDelivery,
        useValue: {
          send: async () => {
            throw new ServiceUnavailableException('private provider detail');
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const responses = await Promise.all(
      [knownEmail, 'unknown-reset@example.test'].map(async (email) => {
        const response = await fetch(`${base}/v1/auth/password-reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        return { status: response.status, body: await response.json() };
      }),
    );
    assert.deepEqual(responses[0], responses[1]);
    assert.deepEqual(responses[0], { status: 201, body: { accepted: true } });
  } finally {
    await app.close();
  }
});

test('reset failures emit only a fixed sanitized event and successful or unknown requests retain acceptance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: unknown[][] = [];
  t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => {
    events.push(args);
  });
  const messages: { destination: string; purpose: string; token: string }[] =
    [];
  let fails = true;
  const email = 'sensitive-reset@example.test';
  const auth = new AuthService(
    {
      rows: async (_sql: string, values: string[]) =>
        values[0] === email ? [{ id: 'private-user', email }] : [],
      transaction: async (work: (sql: unknown) => Promise<void>) =>
        work({ query: async () => ({ rows: [] }) }),
    } as unknown as Database,
    { record: async () => {} } as unknown as Audit,
    {
      send: async (message) => {
        messages.push(message);
        if (fails) throw new Error(`${email} ${message.token} gateway-secret`);
      },
    },
  );
  for (const destination of [email, 'unknown@example.test', email]) {
    const pending = auth.request({ email: destination }, 'reset');
    // Drain challenge transaction microtasks before advancing the response timer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5100);
    assert.deepEqual(await pending, { accepted: true });
    fails = false;
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.destination, email);
  assert.equal(messages[1]!.purpose, 'reset');
  assert.match(messages[1]!.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(events, [['auth.password_reset.delivery_failed']]);
});

test('valid unknown reset requests wait for the gateway timeout envelope but invalid requests fail immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const auth = new AuthService(
    { rows: async () => [] } as unknown as Database,
    {} as Audit,
    { send: async () => {} },
  );
  await assert.rejects(
    auth.request({ email: 'invalid' }, 'reset'),
    BadRequestException,
  );
  let completed = false;
  const pending = auth
    .request({ email: 'unknown@example.test' }, 'reset')
    .then((value) => {
      completed = true;
      return value;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  t.mock.timers.tick(5000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  t.mock.timers.tick(100);
  assert.deepEqual(await pending, { accepted: true });
});
test('Migration cleanup preserves primary failures and discards unsafe pooled connections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raui-migrate-unit-'));
  try {
    for (const mode of [
      'rollback',
      'unlock-after-error',
      'unlock-after-success',
    ]) {
      const primary = new Error('primary fixture failure');
      const cleanup = new Error('cleanup fixture failure');
      let discarded: boolean | undefined;
      const client = {
        query: async (statement: string) => {
          if (
            statement.startsWith('CREATE TABLE') &&
            mode !== 'unlock-after-success'
          )
            throw primary;
          if (statement === 'ROLLBACK' && mode === 'rollback') throw cleanup;
          if (statement.includes('pg_advisory_unlock') && mode !== 'rollback')
            throw cleanup;
          return { rows: [] };
        },
        release: (destroy: boolean) => {
          discarded = destroy;
        },
      };
      const pool = { connect: async () => client } as unknown as Pool;
      await assert.rejects(
        migrate(pool, directory),
        (error) =>
          error === (mode === 'unlock-after-success' ? cleanup : primary),
      );
      assert.equal(discarded, true, mode);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('owner quota OpenAPI distinguishes owner capacity from nonowner null fields', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/v1/account/publication-quota': { get: { responses: {} } },
      '/v1/admin/moderation/{id}/decision': { post: { responses: {} } },
    },
  };
  enrichOpenApi(document);
  const read = document.paths['/v1/account/publication-quota']!.get!;
  const response = read.responses!['200'];
  assert.ok(response && 'content' in response);
  const schema = response.content!['application/json']!.schema;
  assert.ok(schema && 'oneOf' in schema);
  assert.equal(schema.oneOf!.length, 2);
  for (const item of schema.oneOf!) {
    assert.ok('properties' in item);
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required, [
      'applies',
      'limit',
      'publishedObjects',
      'remaining',
    ]);
  }
  assert.deepEqual(read.security, [{ bearer: [] }, { cookie: [] }]);
  const decision = document.paths['/v1/admin/moderation/{id}/decision']!.post!;
  const conflict = decision.responses!['409'];
  assert.ok(conflict && 'content' in conflict);
  assert.match(
    JSON.stringify(conflict.content),
    /OWNER_PUBLICATION_QUOTA_EXCEEDED/,
  );
});

test('organization membership OpenAPI documents irreversible partner revocation', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/v1/organizations/{id}/members': { patch: { responses: {} } },
    },
  };
  enrichOpenApi(document);
  const operation = document.paths['/v1/organizations/{id}/members']!.patch!;
  assert.match(operation.description!, /permanently revokes/i);
  assert.match(operation.description!, /reactivation does not restore/i);
});

test('OpenAPI enrichment preserves path metadata and query parameters on repeated calls', () => {
  const query = {
    in: 'query' as const,
    name: 'fixture',
    schema: { type: 'string' as const },
  };
  const pathParameter = {
    in: 'path' as const,
    name: 'id',
    required: true,
    schema: { type: 'string' as const },
  };
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/v1/organizations': {
        parameters: [pathParameter],
        servers: [{ url: 'https://example.test' }],
        post: {
          responses: {},
          parameters: [
            query,
            {
              in: 'header',
              name: 'Idempotency-Key',
              schema: { type: 'string' },
            },
          ],
        },
      },
      '/v1/commerce/webhook': { post: { responses: {}, parameters: [query] } },
      '/v1/search/sitemap': { get: { responses: {}, parameters: [query] } },
    },
  };
  enrichOpenApi(document);
  enrichOpenApi(document);
  assert.deepEqual(document.paths['/v1/organizations']!.parameters, [
    pathParameter,
  ]);
  assert.deepEqual(document.paths['/v1/organizations']!.servers, [
    { url: 'https://example.test' },
  ]);
  for (const path of ['/v1/organizations', '/v1/commerce/webhook']) {
    const parameters = document.paths[path]!.post!.parameters!;
    assert.equal(parameters.length, 2);
    assert.deepEqual(parameters[0], query);
  }
  assert.equal(
    document.paths['/v1/search/sitemap']!.get!.parameters!.length,
    2,
  );
});

test('registration approval contract is scoped, strict and requires retry keys', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/v1/admin/registration-approvals/{id}/decision': {
        post: { responses: {} },
      },
      '/v1/auth/register': { post: { responses: {} } },
      '/v1/auth/me': { get: { responses: {} } },
      '/v1/admin/users/{id}/permissions': { patch: { responses: {} } },
    },
  };
  enrichOpenApi(document);
  const decision =
    document.paths['/v1/admin/registration-approvals/{id}/decision']!.post!;
  assert.ok(
    decision.parameters?.some(
      (p) => 'name' in p && p.name === 'Idempotency-Key' && p.required,
    ),
  );
  const serialized = JSON.stringify(decision.requestBody);
  assert.ok(serialized.includes('"additionalProperties":false'));
  assert.ok(serialized.includes('"approve"'));
  assert.ok(serialized.includes('"reason"'));
  assert.ok(
    JSON.stringify(document.paths['/v1/auth/me']!.get!.responses).includes(
      'registration_approval_state',
    ),
  );
  assert.ok(
    JSON.stringify(
      document.paths['/v1/auth/register']!.post!.responses,
    ).includes('verificationDelivery'),
  );
  assert.ok(
    JSON.stringify(
      document.paths['/v1/admin/users/{id}/permissions']!.patch!.requestBody,
    ).includes('registration.decide'),
  );
});
test('adaptive hashes use independent salts and reject incorrect passwords', async () => {
  const first = await passwordHash('a-strong-password'),
    second = await passwordHash('a-strong-password');
  assert.notEqual(first, second);
  assert.ok(await passwordMatches('a-strong-password', first));
  assert.equal(await passwordMatches('incorrect', first), false);
});
test('listing lifecycle blocks publication bypass, terminal changes and incompatible deal outcomes', () => {
  assertTransition('draft', 'processing', 'sale');
  assertTransition('published', 'sold', 'sale');
  assert.throws(
    () => assertTransition('draft', 'published', 'sale'),
    ConflictException,
  );
  assert.throws(
    () => assertTransition('sold', 'draft', 'sale'),
    ConflictException,
  );
  assert.throws(
    () => assertTransition('published', 'rented', 'sale'),
    BadRequestException,
  );
});
test('configurable attributes reject unknown fields, enforce types, enums and publication requirements', () => {
  const definitions = [
    { code: 'area', kind: 'number' as const, required: true, options: [] },
    {
      code: 'renovation',
      kind: 'enum' as const,
      required: false,
      options: ['new'],
    },
  ];
  validateAttributes(definitions, {}, false);
  validateAttributes(definitions, { area: 50, renovation: 'new' }, true);
  for (const values of [
    {},
    { area: -1 },
    { area: '50' },
    { area: 50, extra: true },
    { area: 50, renovation: 'unknown' },
  ])
    assert.throws(
      () => validateAttributes(definitions, values, true),
      BadRequestException,
    );
});
test('images require genuine content, matching extensions and bounded input', async () => {
  const image = await sharp({
    create: { width: 10, height: 20, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  assert.equal(
    (await validateImage(image, 'image/png', 'photo.png')).height,
    20,
  );
  await assert.rejects(
    validateImage(image, 'image/jpeg', 'photo.jpg'),
    BadRequestException,
  );
  await assert.rejects(
    validateImage(Buffer.from('<svg/>'), 'image/png', 'file.png'),
    BadRequestException,
  );
  await assert.rejects(
    validateImage(image, 'image/png', 'photo.webp'),
    BadRequestException,
  );
  await assert.rejects(
    validateImage(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png', 'photo.png'),
    BadRequestException,
  );
});
test('production refuses local verification/storage fallback', () => {
  assert.equal(
    envSchema.safeParse({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://raui.ru',
      DATABASE_URL: 'postgresql://localhost/raui',
      REDIS_URL: 'redis://localhost',
    }).success,
    false,
  );
});
test('module boundaries prevent controllers from executing SQL and media from depending on listing workflow', async () => {
  const { readFile } = await import('node:fs/promises');
  const { glob } = await import('node:fs/promises');
  for await (const filename of glob('src/modules/**/*.ts')) {
    const source = await readFile(filename, 'utf8');
    const controller = source.indexOf('@Controller(');
    if (controller >= 0) {
      const moduleEnd = source.indexOf('@Module(', controller);
      const section = source.slice(
        controller,
        moduleEnd >= 0 ? moduleEnd : undefined,
      );
      assert.doesNotMatch(section, /\.query\(|\.rows\(/, filename);
    }
    if (filename.includes('/media/'))
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/listings\/listings['"]/,
        filename,
      );
    if (filename.includes('/database/'))
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/(auth|listings|properties|media)\//,
        filename,
      );
  }
});

test('address contract accepts explicit region selection while preserving legacy input', () => {
  const address = {
    formatted: 'Москва, Тверская',
    locality: 'Москва',
    longitude: 37.6,
    latitude: 55.7,
  };
  assert.equal(addressSchema.parse(address).regionCode, undefined);
  for (const regionCode of ['moscow', 'moscow_oblast'])
    assert.equal(
      addressSchema.parse({ ...address, regionCode }).regionCode,
      regionCode,
    );
  for (const regionCode of ['', '../moscow', 'Moscow', null])
    assert.equal(
      addressSchema.safeParse({ ...address, regionCode }).success,
      false,
    );
});

test('Geo validates catalogue membership before writing an address', async () => {
  const catalogue = new RegionCatalogue(loadRegionDocuments('config/regions'));
  let writes = 0;
  const db = {
    rows: async () => {
      writes++;
      return [{ id: 'fixture' }];
    },
  } as unknown as Database;
  const geo = new Geo(db, catalogue);
  const address = {
    formatted: 'Fixture address',
    locality: 'Fixture',
    longitude: 37.6,
    latitude: 55.7,
  };
  await assert.rejects(
    geo.create({} as Pool, { ...address, regionCode: 'unknown' }),
    BadRequestException,
  );
  assert.equal(writes, 0);
  for (const regionCode of ['moscow', 'moscow_oblast'])
    assert.equal(
      await geo.create({} as Pool, { ...address, regionCode }),
      'fixture',
    );
  assert.equal(await geo.create({} as Pool, address), 'fixture');
  assert.equal(writes, 3);
});

test('CSRF recovery OpenAPI requires cookie authentication and exposes only the token schema', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: { '/v1/auth/csrf': { get: { responses: {} } } },
  };
  enrichOpenApi(document);
  const operation = document.paths['/v1/auth/csrf']!.get!;
  assert.deepEqual(operation.security, [{ cookie: [] }]);
  assert.ok(operation.responses['200']);
  assert.ok(operation.responses['401']);
});

test('Moderation image OpenAPI describes private binary images and restricts variants', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1' },
    paths: {
      '/v1/admin/moderation/{id}/media/{mediaId}/{variant}': {
        get: { responses: {} },
      },
    },
  };
  enrichOpenApi(document);
  const operation =
    document.paths['/v1/admin/moderation/{id}/media/{mediaId}/{variant}']!.get!;
  assert.match(operation.description!, /moderation.read/);
  assert.deepEqual(operation.responses['200'], {
    description:
      'Ready image for the current pending moderation case; private, no-store',
    content: {
      'image/webp': { schema: { type: 'string', format: 'binary' } },
      'image/avif': { schema: { type: 'string', format: 'binary' } },
    },
  });
  const variant = operation.parameters!.find(
    (p) => 'name' in p && p.name === 'variant',
  );
  assert.deepEqual(variant, {
    name: 'variant',
    in: 'path',
    required: true,
    schema: { type: 'string', enum: ['thumb', 'small', 'large', 'avif'] },
  });
});

test('phone OTP OpenAPI is authenticated, strict and keeps legacy confirmation separate', () => {
  const base = '/v1/auth/verification/phone';
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'OTP', version: '1' },
    paths: {
      [`${base}/capabilities`]: { get: { responses: {} } },
      [`${base}/otp`]: { post: { responses: {} } },
      [`${base}/otp/confirm`]: { post: { responses: {} } },
      [`${base}/confirm`]: { post: { responses: {} } },
    },
  };
  enrichOpenApi(document);
  for (const [path, method] of [
    [`${base}/capabilities`, 'get'],
    [`${base}/otp`, 'post'],
    [`${base}/otp/confirm`, 'post'],
  ] as const) {
    const operation = document.paths[path]![method]!;
    assert.deepEqual(operation.security, [{ bearer: [] }, { cookie: [] }]);
    assert.match(operation.description!, /no-store/);
  }
  const request = document.paths[`${base}/otp`]!.post!;
  assert.ok(
    request.parameters!.some(
      (p) => 'name' in p && p.name === 'Idempotency-Key' && p.required,
    ),
  );
  assert.ok(request.responses['429']);
  assert.ok(request.responses['503']);
  const confirm = document.paths[`${base}/otp/confirm`]!.post!;
  const body = confirm.requestBody as {
    content: {
      'application/json': {
        schema: {
          additionalProperties: boolean;
          properties: Record<string, { pattern?: string }>;
        };
      };
    };
  };
  assert.equal(
    body.content['application/json'].schema.additionalProperties,
    false,
  );
  assert.equal(
    body.content['application/json'].schema.properties.code!.pattern,
    '^[0-9]{6}$',
  );
  assert.equal(
    body.content['application/json'].schema.properties.token,
    undefined,
  );
  const legacy = document.paths[`${base}/confirm`]!.post!
    .requestBody as typeof body;
  assert.equal(
    legacy.content['application/json'].schema.properties.token!.pattern,
    '^[A-Za-z0-9_-]{43}$',
  );
});

test('public registration requires an explicit supported role', () => {
  const input = {
    email: 'role@example.test',
    password: 'long-enough-password',
    displayName: 'Role fixture',
  };
  assert.equal(registerSchema.safeParse(input).success, false);
  for (const role of ['buyer', 'owner', 'agent', 'agency', 'developer']) {
    assert.equal(registerSchema.safeParse({ ...input, role }).success, true);
  }
  for (const role of ['admin', 'moderator', 'advertiser', '', 'unknown']) {
    assert.equal(registerSchema.safeParse({ ...input, role }).success, false);
  }
});
