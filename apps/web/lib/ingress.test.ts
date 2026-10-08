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
