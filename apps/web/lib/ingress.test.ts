import { afterEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/[...path]/route';
import { verifyIdentity } from '@raui/config/ingress';
import { detail } from './server';
import { GET as sitemap } from '../app/sitemap.xml/route';
import { sitemapPage, sitemapIndex } from './sitemap';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '8.8.8.8' }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
test('personal drafts can be listed and saved through the authenticated web proxy', async () => {
  const origin = 'https://staging.raui.ru';
  const collection = ['v1', 'account', 'listing-drafts'];
  const item = [...collection, '11111111-1111-4111-8111-111111111111'];
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('WEB_ORIGIN', origin);
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  const { GET, PUT } = await import('../app/api/[...path]/route');
  async function request(path: string[], method: 'GET' | 'PUT', from = origin) {
    const req = new NextRequest(origin + '/api/' + path.join('/'), {
      method,
      headers: { origin: from, 'x-csrf-token': 'test-token' },
      ...(method === 'PUT' ? { body: '{}' } : {}),
    });
    return (method === 'GET' ? GET : PUT)(req, {
      params: Promise.resolve({ path }),
    });
  }
  expect((await request(collection, 'GET')).status).toBe(200);
  expect((await request(item, 'PUT')).status).toBe(200);
  expect((await request(item, 'PUT', 'https://other.example')).status).toBe(
    403,
  );
  expect((await request(item, 'GET')).status).toBe(404);
  expect((await request(collection, 'PUT')).status).toBe(404);
  expect((await request(['v1', 'listings'], 'PUT')).status).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('Production web proxy refuses absent ingress identity before contacting API', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'production');
  vi.stubEnv('WEB_ORIGIN', 'https://raui.ru');
  vi.stubEnv('API_INTERNAL_URL', 'https://api.internal');
  vi.stubEnv('PROXY_IDENTITY_SECRET', 'synthetic-forwarding-key-'.repeat(2));
  vi.stubEnv('TRUSTED_INGRESS_IP_HEADER', 'x-real-ip');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const response = await POST(
    new NextRequest('https://raui.ru/api/v1/search', {
      method: 'POST',
      headers: { origin: 'https://raui.ru' },
      body: '{}',
    }),
    { params: Promise.resolve({ path: ['v1', 'search'] }) },
  );
  expect(response.status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});
test('Web proxy signs only the configured ingress identity and overwrites caller signatures', async () => {
  const secret = 'synthetic-forwarding-key-'.repeat(2);
  vi.stubEnv('DEPLOYMENT_ENV', 'production');
  vi.stubEnv('WEB_ORIGIN', 'https://raui.ru');
  vi.stubEnv('API_INTERNAL_URL', 'https://api.internal');
  vi.stubEnv('PROXY_IDENTITY_SECRET', secret);
  vi.stubEnv('TRUSTED_INGRESS_IP_HEADER', 'x-real-ip');
  let ip: string | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe('https://api.internal/v1/search?limit=1');
      ip = verifyIdentity(
        Object.fromEntries(new Headers(options.headers)),
        'POST',
        '/v1/search?limit=1',
        secret,
      );
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const response = await POST(
    new NextRequest('https://raui.ru/api/v1/search?limit=1', {
      method: 'POST',
      body: '{}',
      headers: {
        origin: 'https://raui.ru',
        'x-real-ip': '8.8.8.8',
        'x-forwarded-for': 'attacker',
        'x-raui-client-ip': '127.0.0.1',
        'x-raui-forwarded-signature': 'forged',
      },
    }),
    { params: Promise.resolve({ path: ['v1', 'search'] }) },
  );
  expect(response.status).toBe(200);
  expect(ip).toBe('8.8.8.8');
});
test('Production SSR detail and sitemap sign every internal API request', async () => {
  const secret = 'synthetic-forwarding-key-'.repeat(2);
  vi.stubEnv('DEPLOYMENT_ENV', 'production');
  vi.stubEnv('API_INTERNAL_URL', 'https://api.internal');
  vi.stubEnv('PROXY_IDENTITY_SECRET', secret);
  vi.stubEnv('TRUSTED_INGRESS_IP_HEADER', 'x-real-ip');
  let requests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const target = new URL(url).pathname;
      expect(
        verifyIdentity(
          Object.fromEntries(new Headers(options.headers)),
          'GET',
          target,
          secret,
        ),
      ).toBe('8.8.8.8');
      expect(options.redirect).toBe('error');
      requests++;
      return new Response(
        JSON.stringify(
          target.includes('/listings/')
            ? { id: 'a'.repeat(36) }
            : { pageSize: 49999, cursors: [null] },
        ),
      );
    }),
  );
  expect(await detail('a'.repeat(36))).toEqual({ id: 'a'.repeat(36) });
  const index = await sitemap(
    new Request('https://raui.ru/sitemap.xml', {
      headers: { 'x-real-ip': '8.8.8.8' },
    }),
  );
  expect(index.status).toBe(200);
  expect(await index.text()).toContain('/sitemaps/start.xml');
  expect(requests).toBe(2);
});
test('Sitemap never exceeds the fifty-thousand URL protocol limit', async () => {
  const rows = Array.from({ length: 50001 }, (_, n) => ({
    id: `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    published_at: '2026-10-05T00:00:00.000Z',
  }));
  expect(() => sitemapPage(rows, true)).toThrow('Sitemap page invalid');
  const first = sitemapPage(rows.slice(0, 49999), true);
  expect(first.match(/<url>/g)).toHaveLength(50000);
  const second = sitemapPage(rows.slice(49999), false);
  expect(second.match(/<url>/g)).toHaveLength(2);
  const ids = [
    ...first.matchAll(/\/listings\/([^<]+)/g),
    ...second.matchAll(/\/listings\/([^<]+)/g),
  ].map((match) => match[1]);
  expect(ids).toEqual(rows.map((row) => row.id));
  expect(sitemapPage(rows.slice(0, 49999), false).match(/<url>/g)).toHaveLength(
    49999,
  );
  expect(sitemapIndex([null, rows[49998]!.id])).toContain(
    rows[49998]!.id + '.xml',
  );
  expect(sitemapPage([], true, 'https://example.test?a=1&b=2')).toContain(
    '&amp;',
  );
});

test('Regional catalogue is reachable through the public web proxy', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  const { GET } = await import('../app/api/[...path]/route');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:3001/v1/regions');
      return new Response(
        JSON.stringify({ items: [{ code: 'moscow', name: 'Москва' }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }),
  );
  const response = await GET(
    new NextRequest('https://staging.raui.ru/api/v1/regions'),
    {
      params: Promise.resolve({ path: ['v1', 'regions'] }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [{ code: 'moscow', name: 'Москва' }],
  });
});

test('CSRF recovery proxy rejects cross-origin browser reads before contacting API', async () => {
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const { GET } = await import('../app/api/[...path]/route');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const headers of [
    { origin: 'https://attacker.test' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await GET(
      new NextRequest('https://staging.raui.ru/api/v1/auth/csrf', { headers }),
      {
        params: Promise.resolve({ path: ['v1', 'auth', 'csrf'] }),
      },
    );
    expect(response.status).toBe(403);
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('feedback forwards authenticated submissions and admin reads only', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const { GET, POST } = await import('../app/api/[...path]/route');
  const upstream = vi.fn(
    async () =>
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', upstream);
  const origin = 'https://staging.raui.ru';
  for (const [method, path, status] of [
    ['GET', 'admin/feedback?cursor=next-page', 200],
    ['POST', 'account/feedback', 200],
    ['GET', 'account/feedback', 404],
    ['POST', 'admin/feedback', 404],
    ['GET', 'admin/feedback/extra', 404],
    ['POST', 'account/feedback/extra', 404],
  ] as const) {
    const request = new NextRequest(origin + '/api/v1/' + path, {
      method,
      headers: { origin, 'x-csrf-token': 'fixture-token' },
    });
    const handler = method === 'GET' ? GET : POST;
    expect(
      (
        await handler(request, {
          params: Promise.resolve({
            path: ['v1', ...path.split('?')[0]!.split('/')],
          }),
        })
      ).status,
    ).toBe(status);
  }
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(upstream).toHaveBeenCalledWith(
    'http://127.0.0.1:3001/v1/admin/feedback?cursor=next-page',
    expect.anything(),
  );
});

test('staff permissions proxy forwards only the bounded admin routes', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const { GET, PATCH } = await import('../app/api/[...path]/route');
  const fetcher = vi.fn(async (...args: unknown[]) => {
    void args;
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const id = '11111111-1111-4111-8111-111111111111';
  const path = ['v1', 'admin', 'users', id, 'permissions'];
  const granted = await PATCH(
    new NextRequest('https://staging.raui.ru/api/' + path.join('/'), {
      method: 'PATCH',
      headers: {
        origin: 'https://staging.raui.ru',
        'x-csrf-token': 'fixture-csrf',
      },
      body: '{}',
    }),
    { params: Promise.resolve({ path }) },
  );
  expect(granted.status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    'http://127.0.0.1:3001/v1/admin/users/' + id + '/permissions',
  );
  const denied = await GET(
    new NextRequest('https://staging.raui.ru/api/v1/admin/audit'),
    { params: Promise.resolve({ path: ['v1', 'admin', 'audit'] }) },
  );
  expect(denied.status).toBe(404);
  const wrongMethod = await PATCH(
    new NextRequest('https://staging.raui.ru/api/v1/admin/users', {
      method: 'PATCH',
      headers: { origin: 'https://staging.raui.ru' },
      body: '{}',
    }),
    { params: Promise.resolve({ path: ['v1', 'admin', 'users'] }) },
  );
  expect(wrongMethod.status).toBe(404);
  expect(fetcher).toHaveBeenCalledOnce();
});

test('owner and moderation proxy exposes only selected methods and preserves idempotency', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const fetcher = vi.fn(async (...args: unknown[]) => {
    void args;
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const { GET, PATCH, POST } = await import('../app/api/[...path]/route');
  const id = '11111111-1111-4111-8111-111111111111';
  for (const path of [
    ['v1', 'properties'],
    ['v1', 'organizations'],
    ['v1', 'admin', 'moderation', id, 'decision'],
  ]) {
    const response = await POST(
      new NextRequest('https://staging.raui.ru/api/' + path.join('/'), {
        method: 'POST',
        headers: {
          origin: 'https://staging.raui.ru',
          'idempotency-key': 'stable-key',
        },
        body: '{}',
      }),
      { params: Promise.resolve({ path }) },
    );
    expect(response.status).toBe(200);
  }
  expect(
    new Headers((fetcher.mock.calls[0]?.[1] as RequestInit)?.headers).get(
      'idempotency-key',
    ),
  ).toBe('stable-key');
  for (const path of [
    ['v1', 'admin', 'moderation'],
    ['v1', 'organizations', id, 'members'],
    ['v1', 'admin', 'moderation', id, 'materials'],
    ['v1', 'admin', 'moderation', id, 'media', id, 'small'],
  ]) {
    expect(
      (
        await GET(
          new NextRequest('https://staging.raui.ru/api/' + path.join('/')),
          { params: Promise.resolve({ path }) },
        )
      ).status,
    ).toBe(200);
  }
  for (const path of [
    ['v1', 'properties', 'arbitrary'],
    ['v1', 'organizations', 'arbitrary', 'members'],
    ['v1', 'organizations', id, 'permissions'],
    ['v1', 'admin', 'moderation', id, 'permissions'],
    ['v1', 'admin', 'moderation', id, 'media', id, 'original'],
  ]) {
    expect(
      (
        await GET(
          new NextRequest('https://staging.raui.ru/api/' + path.join('/')),
          { params: Promise.resolve({ path }) },
        )
      ).status,
    ).toBe(404);
  }
  const membersPath = ['v1', 'organizations', id, 'members'];
  expect(
    (
      await PATCH(
        new NextRequest(
          'https://staging.raui.ru/api/' + membersPath.join('/'),
          {
            method: 'PATCH',
            headers: { origin: 'https://staging.raui.ru' },
            body: '{}',
          },
        ),
        { params: Promise.resolve({ path: membersPath }) },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await PATCH(
        new NextRequest('https://staging.raui.ru/api/v1/admin/moderation', {
          method: 'PATCH',
          headers: { origin: 'https://staging.raui.ru' },
          body: '{}',
        }),
        { params: Promise.resolve({ path: ['v1', 'admin', 'moderation'] }) },
      )
    ).status,
  ).toBe(404);
});

test('organization feed proxy admits the one-link import entry point only', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const fetcher = vi.fn(async (...args: unknown[]) => {
    void args;
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const { GET, POST } = await import('../app/api/[...path]/route');
  const id = '11111111-1111-4111-8111-111111111111';
  const link = ['v1', 'organizations', id, 'feeds', 'link'];
  expect(
    (
      await POST(
        new NextRequest('https://staging.raui.ru/api/' + link.join('/'), {
          method: 'POST',
          headers: { origin: 'https://staging.raui.ru' },
          body: '{}',
        }),
        { params: Promise.resolve({ path: link }) },
      )
    ).status,
  ).toBe(200);
  for (const base of [
    ['v1', 'organizations', id, 'feeds'],
    ['v1', 'account', 'feeds'],
  ]) {
    for (const tail of [
      ['links'],
      [id, 'runs', id],
      [id, 'runs', id, 'items'],
    ]) {
      const path = [...base, ...tail];
      expect(
        (
          await GET(
            new NextRequest('https://staging.raui.ru/api/' + path.join('/')),
            { params: Promise.resolve({ path }) },
          )
        ).status,
      ).toBe(200);
    }
    for (const tail of [
      [],
      ['link'],
      ['links', 'unknown'],
      [id, 'runs', 'bad'],
      [id, 'runs', id, 'retry'],
    ]) {
      const path = [...base, ...tail];
      expect(
        (
          await GET(
            new NextRequest('https://staging.raui.ru/api/' + path.join('/')),
            { params: Promise.resolve({ path }) },
          )
        ).status,
      ).toBe(404);
    }
  }
  expect(
    (
      await POST(
        new NextRequest(
          'https://staging.raui.ru/api/' +
            ['v1', 'organizations', id, 'feeds', 'unexpected'].join('/'),
          {
            method: 'POST',
            headers: { origin: 'https://staging.raui.ru' },
            body: '{}',
          },
        ),
        {
          params: Promise.resolve({
            path: ['v1', 'organizations', id, 'feeds', 'unexpected'],
          }),
        },
      )
    ).status,
  ).toBe(404);
});

test('feed trust proxy exposes source pagination and versioned decisions with the existing origin protection', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response('{}'),
  );
  vi.stubGlobal('fetch', fetcher);
  const { GET, PATCH } = await import('../app/api/[...path]/route');
  const id = '11111111-1111-4111-8111-111111111111';
  const base = ['v1', 'admin', 'integrations', 'feeds'];
  const path = [...base, id, 'trust'];
  const origin = 'https://staging.raui.ru';
  const url = origin + '/api/' + path.join('/');
  expect(
    (
      await GET(
        new NextRequest(origin + '/api/' + base.join('/') + '?after=' + id),
        { params: Promise.resolve({ path: base }) },
      )
    ).status,
  ).toBe(200);
  expect(String(fetcher.mock.calls[0]![0])).toContain('?after=' + id);
  expect(
    (
      await PATCH(
        new NextRequest(url, {
          method: 'PATCH',
          headers: { origin },
          body: '{}',
        }),
        { params: Promise.resolve({ path }) },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await PATCH(
        new NextRequest(url, {
          method: 'PATCH',
          headers: { origin: 'https://other.example' },
          body: '{}',
        }),
        { params: Promise.resolve({ path }) },
      )
    ).status,
  ).toBe(403);
  expect(
    (await GET(new NextRequest(url), { params: Promise.resolve({ path }) }))
      .status,
  ).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('registration approval proxy admits only queue, detail and idempotent decision', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const fetcher = vi.fn(async (...args: unknown[]) => {
    void args;
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const { GET, POST, PATCH } = await import('../app/api/[...path]/route');
  const id = '11111111-1111-4111-8111-111111111111';
  const base = ['v1', 'admin', 'registration-approvals'];
  for (const path of [base, [...base, id]]) {
    expect(
      (
        await GET(
          new NextRequest('https://staging.raui.ru/api/' + path.join('/')),
          { params: Promise.resolve({ path }) },
        )
      ).status,
    ).toBe(200);
  }
  const path = [...base, id, 'decision'];
  expect(
    (
      await POST(
        new NextRequest('https://staging.raui.ru/api/' + path.join('/'), {
          method: 'POST',
          headers: {
            origin: 'https://staging.raui.ru',
            'idempotency-key': 'approval-retry-key',
          },
          body: '{}',
        }),
        { params: Promise.resolve({ path }) },
      )
    ).status,
  ).toBe(200);
  expect(
    new Headers((fetcher.mock.calls[2]?.[1] as RequestInit).headers).get(
      'idempotency-key',
    ),
  ).toBe('approval-retry-key');
  for (const denied of [
    [...base, 'bad-id'],
    [...base, id, 'permissions'],
    [...base, id, 'decision'],
  ]) {
    expect(
      (
        await GET(
          new NextRequest('https://staging.raui.ru/api/' + denied.join('/')),
          { params: Promise.resolve({ path: denied }) },
        )
      ).status,
    ).toBe(404);
  }
  expect(
    (
      await PATCH(
        new NextRequest('https://staging.raui.ru/api/' + path.join('/'), {
          method: 'PATCH',
          headers: { origin: 'https://staging.raui.ru' },
          body: '{}',
        }),
        { params: Promise.resolve({ path }) },
      )
    ).status,
  ).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('seller contact proxy forwards precisely the supported routes and keeps CSRF and no-store for selections', async () => {
  const origin = 'https://staging.raui.ru';
  vi.stubEnv('DEPLOYMENT_ENV', 'development');
  vi.stubEnv('WEB_ORIGIN', origin);
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.cache).toBe('no-store');
    if (init.method === 'PUT') {
      expect(new Headers(init.headers).get('x-csrf-token')).toBe(
        'synthetic-csrf',
      );
      expect(
        JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)),
      ).toEqual({ phoneIds: [], expectedPhoneIds: [] });
      expect(url).toMatch(/\/contact-settings$/);
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  const handlers = await import('../app/api/[...path]/route');
  const id = '11111111-1111-4111-8111-111111111111';
  const selected = 'listings/' + id + '/contact-settings';
  const account = 'account/contact-settings';
  const phones = 'account/contact-phones/';
  const cases = [
    ['PUT', selected, 200],
    ['GET', selected, 200],
    ['GET', account, 200],
    ['PATCH', account, 200],
    ['POST', phones + 'request', 200],
    ['POST', phones + 'verify', 200],
    ['DELETE', phones + id, 200],
    ['PUT', selected, 403, 'https://other.example'],
    ['PUT', 'listings/not-a-uuid/contact-settings', 404],
    ['PUT', selected + '/more', 404],
    ['PUT', 'listings/' + id, 404],
    ['PATCH', selected, 404],
    ['PUT', account, 404],
    ['POST', account, 404],
    ['PATCH', account + '/other', 404],
    ['GET', phones + 'request', 404],
    ['POST', phones + 'verify/more', 404],
    ['DELETE', phones + 'not-a-uuid', 404],
  ] as const;
  for (const [method, route, expected, sender = origin] of cases) {
    const path = ['v1', ...route.split('/')];
    const response = await handlers[method](
      new NextRequest(origin + '/api/' + path.join('/'), {
        method,
        headers: { origin: sender, 'x-csrf-token': 'synthetic-csrf' },
        ...(method === 'GET'
          ? {}
          : { body: JSON.stringify({ phoneIds: [], expectedPhoneIds: [] }) }),
      }),
      { params: Promise.resolve({ path }) },
    );
    expect(response.status, method + ' ' + route).toBe(expected);
    if (expected === 200)
      expect(response.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).toHaveBeenCalledTimes(7);
});

test('phone OTP proxy accepts only exact methods and forwards idempotency without caching', async () => {
  vi.stubEnv('DEPLOYMENT_ENV', 'local');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'https://staging.raui.ru');
  const fetcher = vi.fn(async (...args: unknown[]) => {
    void args;
    return new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const { GET, POST, PATCH } = await import('../app/api/[...path]/route');
  const base = ['v1', 'auth', 'verification', 'phone'];
  for (const [method, suffix, allowed] of [
    ['GET', ['capabilities'], true],
    ['POST', ['otp'], true],
    ['POST', ['otp', 'confirm'], true],
    ['POST', ['capabilities'], false],
    ['GET', ['otp'], false],
    ['GET', ['otp', 'confirm'], false],
    ['POST', ['otp', 'confirm', 'extra'], false],
    ['PATCH', ['otp'], false],
  ] as const) {
    const path = [...base, ...suffix];
    const handler = method === 'GET' ? GET : method === 'POST' ? POST : PATCH;
    const response = await handler(
      new NextRequest('https://staging.raui.ru/api/' + path.join('/'), {
        method,
        headers: {
          origin: 'https://staging.raui.ru',
          'idempotency-key': 'phone-otp-request-key',
        },
        ...(method === 'GET' ? {} : { body: '{}' }),
      }),
      { params: Promise.resolve({ path }) },
    );
    expect(response.status).toBe(allowed ? 200 : 404);
    if (allowed)
      expect(response.headers.get('cache-control')).toContain('no-store');
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(
    new Headers((fetcher.mock.calls[1]?.[1] as RequestInit).headers).get(
      'idempotency-key',
    ),
  ).toBe('phone-otp-request-key');
});
