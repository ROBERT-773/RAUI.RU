import { afterEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/[...path]/route';
import { verifyIdentity } from '@raui/config/ingress';
import { detail } from './server';
import sitemap from '../app/sitemap';
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
          target.includes('/listings/') ? { id: 'a'.repeat(36) } : [],
        ),
      );
    }),
  );
  expect(await detail('a'.repeat(36))).toEqual({ id: 'a'.repeat(36) });
  expect(await sitemap()).toHaveLength(1);
  expect(requests).toBe(2);
});
