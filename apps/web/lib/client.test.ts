import { afterEach, expect, test, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.resetModules();
});
type TestFetch = (
  url: string,
  request?: RequestInit,
) => Promise<ReturnType<typeof reply>>;
const reply = (value: unknown = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

test('HTTP failures expose status without exposing backend error details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ message: 'private provider details' }, 401)),
  );
  const { api } = await import('./client');
  await expect(api('v1/auth/me')).rejects.toMatchObject({
    status: 401,
    message: 'Войдите в аккаунт, чтобы продолжить.',
  });
});

test('restored session without storage bootstraps before mutation', async () => {
  const fetch = vi.fn<TestFetch>(async (url) =>
    reply(url.endsWith('/csrf') ? { csrfToken: 'restored' } : { ok: true }),
  );
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./client');
  await api('v1/account/preferences', 'PATCH', { in_app: true });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/auth/csrf',
    '/api/v1/account/preferences',
  ]);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    headers: { 'X-CSRF-Token': 'restored' },
  });
  expect(sessionStorage.getItem('raui_csrf')).toBeNull();
});

test('concurrent mutations share recovery but each later wave refreshes identity', async () => {
  let identity = 'A';
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: { url: string; token: string | undefined }[] = [];
  const fetch = vi.fn(async (url: string, request?: RequestInit) => {
    requests.push({
      url,
      token: (request?.headers as Record<string, string>)?.['X-CSRF-Token'],
    });
    if (url.endsWith('/csrf')) {
      await wait;
      return reply({ csrfToken: identity });
    }
    return reply();
  });
  vi.stubGlobal('fetch', fetch);
  const { api, setCsrf } = await import('./client');
  setCsrf('stale');
  const pending = Promise.all([
    api('v1/first', 'POST'),
    api('v1/second', 'DELETE'),
  ]);
  expect(requests).toHaveLength(1);
  release();
  await pending;
  expect(requests.slice(1).map((r) => r.token)).toEqual(['A', 'A']);
  identity = 'B';
  await api('v1/third', 'PATCH');
  expect(requests.at(-1)?.token).toBe('B');
  expect(requests.filter((r) => r.url.endsWith('/csrf'))).toHaveLength(2);
});

for (const status of [401, 503])
  test(`recovery ${status} ${status === 401 ? 'allows anonymous request without stale token' : 'fails closed'}`, async () => {
    const fetch = vi.fn<TestFetch>(async (url) =>
      url.endsWith('/csrf') ? reply({}, status) : reply(),
    );
    vi.stubGlobal('fetch', fetch);
    const { api, setCsrf } = await import('./client');
    setCsrf('stale');
    if (status === 503) {
      await expect(api('v1/account/preferences', 'PATCH')).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } else {
      await api('v1/account/preferences', 'PATCH');
      expect(fetch.mock.calls[1]?.[1]).toMatchObject({
        headers: { 'Content-Type': 'application/json' },
      });
      expect(
        (fetch.mock.calls[1]?.[1] as RequestInit).headers,
      ).not.toHaveProperty('X-CSRF-Token');
    }
  });

test('failed mutation is never replayed', async () => {
  const fetch = vi.fn<TestFetch>(async (url) =>
    url.endsWith('/csrf') ? reply({ csrfToken: 'token' }) : reply({}, 403),
  );
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./client');
  await expect(api('v1/account/preferences', 'PATCH')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('public credential and challenge routes and reads do not bootstrap', async () => {
  const fetch = vi.fn<TestFetch>(async () => reply());
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./client');
  for (const route of [
    'login',
    'register',
    'password-reset',
    'password-reset/confirm',
    'verification/email/confirm',
  ])
    await api('v1/auth/' + route, 'POST');
  await api('v1/auth/me');
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/csrf'))).toBe(
    false,
  );
});

test('malformed recovery token fails closed', async () => {
  const fetch = vi.fn(async () => reply({}));
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./client');
  await expect(api('v1/account/preferences', 'PATCH')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('critical mutation forwards the same caller idempotency key with recovered CSRF', async () => {
  const fetch = vi.fn<TestFetch>(async (url) =>
    reply(url.endsWith('/csrf') ? { csrfToken: 'current' } : {}),
  );
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./client');
  await api(
    'v1/listings',
    'POST',
    { title: 'Объект' },
    { idempotencyKey: 'stable-request-key' },
  );
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    headers: {
      'X-CSRF-Token': 'current',
      'Idempotency-Key': 'stable-request-key',
    },
  });
});
