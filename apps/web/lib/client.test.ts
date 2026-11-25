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

test('seller contact errors distinguish disabled messages, stale selection, and listings which need a phone', async () => {
  const listing = {
    id: '5ae72277-e111-4272-8bdb-4ebfacb79afa',
    title: 'Квартира с террасой',
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(reply({ code: 'LISTING_MESSAGES_DISABLED' }, 403))
      .mockResolvedValueOnce(
        reply({ code: 'LISTING_CONTACT_SELECTION_CHANGED' }, 409),
      )
      .mockResolvedValueOnce(
        reply(
          {
            code: 'contact_phone_required',
            total: 2,
            listings: [listing, { id: 'invalid', title: 'Ignore' }],
          },
          409,
        ),
      ),
  );
  const { api, ListingContactSelectionChangedError } = await import('./client');
  await expect(api('v1/account/inquiries/' + listing.id)).rejects.toMatchObject(
    { status: 403, message: 'Автор принимает только звонки.' },
  );
  await expect(
    api('v1/listings/' + listing.id + '/contact-settings'),
  ).rejects.toBeInstanceOf(ListingContactSelectionChangedError);
  await expect(api('v1/account/contact-settings')).rejects.toMatchObject({
    status: 409,
    total: 2,
    listings: [listing],
  });
});

test('a URL on an unapproved feed host gives safe administrator guidance', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply(
        {
          code: 'feed_host_not_approved',
          message: 'https://private.example?token=secret',
        },
        400,
      ),
    ),
  );
  const { api } = await import('./client');
  for (const path of [
    'v1/account/feeds/link',
    'v1/organizations/org-1/feeds/link',
  ]) {
    await expect(api(path)).rejects.toMatchObject({
      status: 400,
      message:
        'Домен выгрузки ещё не разрешён. Попросите администратора RAUI разрешить загрузку с этого домена.',
    });
  }
});

test('known publication quota conflict uses safe guidance instead of backend details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply(
        {
          code: 'OWNER_PUBLICATION_QUOTA_EXCEEDED',
          message: 'private database details',
        },
        409,
      ),
    ),
  );
  const { api } = await import('./client');
  await expect(
    api('v1/admin/moderation/example/decision'),
  ).rejects.toMatchObject({
    status: 409,
    message:
      'Разрешено одно активное объявление. Приостановите действующее объявление; сотрудник сможет повторить проверку текущей заявки.',
  });
});

for (const [status, code] of [
  [409, 'STALE_VERSION'],
  [503, 'OWNER_PUBLICATION_QUOTA_EXCEEDED'],
] as const)
  test(`unrelated failure ${status}/${code} retains generic safe guidance`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ code, message: 'private details' }, status)),
    );
    const { api } = await import('./client');
    await expect(api('v1/example')).rejects.toMatchObject({
      status,
      message: 'Не удалось выполнить запрос. Попробуйте ещё раз.',
    });
  });

test.each([
  ['v1/auth/phone-sign-in', 'phone_otp_rate_limited'],
  ['v1/auth/email-sign-in', 'email_sign_in_rate_limited'],
])('uses the retry time from %s without a session', async (path, code) => {
  const fetch = vi.fn(async () => reply({ code, retryAfterSeconds: 60 }, 429));
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('./client');
  await expect(api(path, 'POST', {})).rejects.toMatchObject({
    status: 429,
    retryAfterSeconds: 60,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
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

for (const [status, code, message] of [
  [400, 'phone_otp_invalid', 'Код недействителен или срок его действия истёк.'],
  [
    409,
    'phone_otp_contact_unavailable',
    'Не удалось подтвердить этот телефон. Обратитесь в поддержку.',
  ],
  [
    503,
    'phone_otp_unavailable',
    'SMS сейчас недоступно. Повторите запрос позже.',
  ],
  [
    429,
    'phone_otp_rate_limited',
    'Слишком много запросов SMS. Повторите запрос позже.',
  ],
] as const)
  test(`OTP ${code} exposes only bounded safe guidance`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(
          { code, retryAfterSeconds: 12, message: 'private provider response' },
          status,
        ),
      ),
    );
    const { api } = await import('./client');
    await expect(api('v1/auth/verification/phone/otp')).rejects.toMatchObject({
      status,
      message,
      ...(status === 429 ? { retryAfterSeconds: 12 } : {}),
    });
  });
for (const seconds of [0, -1, 1.2, '12', 10000000])
  test(`OTP retry metadata rejects invalid value ${seconds}`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(
          { code: 'phone_otp_rate_limited', retryAfterSeconds: seconds },
          429,
        ),
      ),
    );
    const { api } = await import('./client');
    await expect(api('v1/auth/verification/phone/otp')).rejects.toMatchObject({
      retryAfterSeconds: undefined,
    });
  });

test('monthly quota conflict explains calendar limit without leaking backend details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply(
        {
          code: 'OWNER_MONTHLY_PUBLICATION_QUOTA_EXCEEDED',
          message: 'private details',
        },
        409,
      ),
    ),
  );
  const { api } = await import('./client');
  await expect(
    api('v1/admin/moderation/example/decision'),
  ).rejects.toMatchObject({
    status: 409,
    message: 'Достигнут лимит: три публикации в календарный месяц.',
  });
});
