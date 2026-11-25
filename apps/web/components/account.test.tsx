import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import Account from './account';
const profileCallbacks = vi.hoisted(() => ({
  expire: undefined as (() => void) | undefined,
}));
vi.mock('./account-profile', () => ({
  default: ({
    onRefresh,
    onSessionExpired,
  }: {
    onRefresh?: () => void;
    onSessionExpired?: () => void;
  }) => {
    profileCallbacks.expire = onSessionExpired;
    return <button onClick={onRefresh}>Обновить профиль</button>;
  },
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
function stubFetch(
  name: string,
  implementation: (input: string, init?: RequestInit) => Promise<unknown>,
) {
  vi.stubGlobal(name, (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/v1/auth/csrf'
      ? Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: 'test-session-csrf' }),
        } as Response)
      : implementation(String(input), init),
  );
}
afterEach(() => {
  cleanup();
  profileCallbacks.expire = undefined;
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

test('opens the profile directly for contact settings and allows returning to the ordinary cabinet', async () => {
  stubFetch('fetch', async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith('/auth/me')
        ? {
            display_name: 'Агент',
            role: 'agent',
            registration_approval_state: 'approved',
          }
        : { items: [], cursor: null },
  }));
  render(<Account initialContacts />);
  expect(
    await screen.findByRole('button', { name: 'Обновить профиль' }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Вернуться к разделам аккаунта' }),
  );
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Профиль и подтверждение контактов',
    }),
  );
  expect(
    await screen.findByRole('button', { name: 'Обновить профиль' }),
  ).toBeTruthy();
});

test('opens the requested messages tab for a signed-in visitor', async () => {
  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/auth/me')
        ? { display_name: 'Агент', role: 'agent' }
        : { items: [], cursor: null },
  }));
  stubFetch('fetch', fetch);
  render(<Account initialTab="messages" />);
  const tab = await screen.findByRole('button', { name: 'Сообщения' });
  expect(tab.getAttribute('aria-pressed')).toBe('true');
  expect(
    fetch.mock.calls.some(([url]) => url.endsWith('/account/threads')),
  ).toBe(true);
});

test('submits a user ID as the password login identifier', async () => {
  const fetch = vi.fn(async () => ({ ok: false, status: 401 }));
  stubFetch('fetch', fetch);
  render(<Account />);
  await screen.findByLabelText('Пароль');
  fireEvent.click(screen.getByRole('button', { name: 'Войти по ID' }));
  fireEvent.change(screen.getByLabelText('ID пользователя'), {
    target: { value: '303' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'synthetic-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Войти$/ }));
  await screen.findByRole('alert');
  expect(fetch).toHaveBeenCalledWith(
    '/api/v1/auth/login',
    expect.objectContaining({
      body: JSON.stringify({
        publicId: '303',
        password: 'synthetic-password',
        transport: 'cookie',
      }),
    }),
  );
});

test('both recovery channels lead to code entry while the password fallback stays available', async () => {
  const fetch = vi.fn(async () => ({ ok: false, status: 401 }));
  stubFetch('fetch', fetch);
  render(
    <Account smsAvailable emailAvailable resetLinkAvailable recoverAccess />,
  );
  await screen.findByRole('heading', { name: 'Восстановить доступ' });
  expect(
    screen
      .getByRole('link', { name: 'Сменить пароль по ссылке' })
      .getAttribute('href'),
  ).toBe('/account/forgot-password?mode=password');
  fireEvent.click(screen.getByRole('button', { name: 'На телефон' }));
  expect(screen.getByLabelText('Мобильный телефон')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Другой способ' }));
  fireEvent.click(screen.getByRole('button', { name: 'На почту' }));
  expect(screen.getByLabelText('Email')).toBeTruthy();
  expect(screen.queryByText('Роль при регистрации')).toBeNull();
  expect(fetch.mock.calls).toHaveLength(1);
});

test('SMS registration opens the pending cabinet after completing the profile', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return { ok: false, status: 401 };
    let value: unknown;
    if (url.endsWith('/auth/phone-sign-in'))
      value = { challengeId: 'sms-challenge', delivery: 'accepted' };
    if (url.endsWith('/auth/phone-sign-in/confirm'))
      value = { kind: 'signup', signupToken: 'sms-signup-proof' };
    if (url.endsWith('/auth/phone-sign-in/register'))
      value = {
        csrfToken: 'sms-csrf',
        user: {
          id: 'sms-owner',
          display_name: 'SMS Owner',
          role: 'owner',
          registration_approval_state: 'pending',
        },
      };
    return { ok: true, status: 201, json: async () => value };
  });
  stubFetch('fetch', fetch);
  render(<Account smsAvailable />);
  const phone = await screen.findByLabelText('Мобильный телефон');
  fireEvent.change(phone, { target: { value: '8 (999) 123-45-67' } });
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  fireEvent.change(await screen.findByLabelText('Код подтверждения'), {
    target: { value: '012345' },
  });
  fireEvent.change(await screen.findByLabelText('Кто вы?'), {
    target: { value: 'owner' },
  });
  fireEvent.change(screen.getByLabelText('Имя'), {
    target: { value: 'SMS Owner' },
  });
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'sms@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'synthetic-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
  const cabinet = await screen.findByRole('heading', {
    name: 'Кабинет собственника',
  });
  expect(document.activeElement).toBe(cabinet);
  expect(sessionStorage.getItem('raui_csrf')).toBe('sms-csrf');
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/auth/me',
    '/api/v1/auth/phone-sign-in',
    '/api/v1/auth/phone-sign-in/confirm',
    '/api/v1/auth/phone-sign-in/register',
  ]);
});

test('shows and hides the password without submitting and masks it on mode change', async () => {
  const fetch = vi.fn(async () => ({ ok: false, status: 401 }));
  vi.stubGlobal('fetch', fetch);
  render(<Account />);
  const field = (await screen.findByLabelText('Пароль')) as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'synthetic-password' } });
  expect(field.type).toBe('password');
  const requests = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
  expect(field.type).toBe('text');
  expect(field.value).toBe('synthetic-password');
  fireEvent.click(screen.getByRole('button', { name: 'Скрыть пароль' }));
  expect(field.type).toBe('password');
  fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
  fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));
  expect((screen.getByLabelText('Пароль') as HTMLInputElement).type).toBe(
    'password',
  );
  expect(fetch.mock.calls).toHaveLength(requests);
});

for (const delayed of [false, true]) {
  test(`Account isolates private state across identities${delayed ? ' with an outstanding response' : ''}`, async () => {
    let identity = 'A';
    let release: (() => void) | undefined;
    const privateMessage = 'Private message belonging only to A';
    stubFetch(
      'fetch',
      vi.fn(async (url: string) => {
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Identity A' };
        else if (url.endsWith('/auth/logout')) identity = '';
        else if (url.endsWith('/auth/login')) {
          identity = 'B';
          value = {
            csrfToken: 'synthetic-csrf-B',
            user: { display_name: 'Identity B' },
          };
        } else if (url.endsWith('/account/threads') && identity === 'A') {
          value = {
            items: [{ id: 'thread-a', listing_id: 'listing-a' }],
            cursor: null,
          };
        } else if (url.endsWith('/thread-a/messages')) {
          value = {
            items: [
              {
                id: 'message-a',
                body: privateMessage,
                created_at: '2026-10-05T00:00:00Z',
              },
            ],
            cursor: null,
          };
          if (delayed)
            await new Promise<void>((done) => {
              release = done;
            });
        }
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByText('Identity A');
    fireEvent.click(screen.getByRole('button', { name: 'Сообщения' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Открыть переписку',
      }),
    );
    if (delayed) await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    else await screen.findByText(privateMessage, { exact: false });
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await screen.findByRole('heading', { name: 'Войти в аккаунт' });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'b@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Пароль'), {
      target: { value: 'synthetic-long-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByText('Identity B');
    if (delayed)
      await act(async () => {
        release!();
      });
    fireEvent.click(screen.getByRole('button', { name: 'Сообщения' }));
    await screen.findByText('Напишите продавцу на странице объявления.');
    expect(screen.queryByText(privateMessage, { exact: false })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Переписка' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(
      (await screen.findByLabelText<HTMLInputElement>('Пароль')).type,
    ).toBe('password');
  });
}

test('Late favorites response cannot replace selected comparison cards or pagination', async () => {
  let release: (() => void) | undefined;
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => {
      let value: unknown = { items: [], cursor: null };
      if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
      else if (url.includes('/account/collections/')) {
        const favorite = url.endsWith('/favorite');
        value = {
          items: [
            {
              id: favorite ? 'favorite-only' : 'compare-only',
              title: favorite ? 'Favorite listing' : 'Comparison listing',
              media: [],
              attributes: {},
              price: 100,
              address: 'Fixture address',
            },
          ],
          cursor: favorite ? 'stale-favorite-cursor' : null,
        };
        if (favorite)
          await new Promise<void>((done) => {
            release = done;
          });
      }
      return { ok: true, json: async () => value };
    }),
  );
  render(<Account />);
  await screen.findByText('Buyer');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Сравнение' }));
  await screen.findByRole('link', { name: 'Comparison listing' });
  await act(async () => {
    release!();
  });
  expect(screen.getByRole('link', { name: 'Comparison listing' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Favorite listing' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
});

for (const mutation of ['favorite-delete', 'saved-rename', 'saved-delete']) {
  test(`Late ${mutation} cannot supersede a comparison request`, async () => {
    let finishMutation: (() => void) | undefined;
    let finishComparison: (() => void) | undefined;
    const card = {
      id: 'favorite-only',
      title: 'Favorite listing',
      media: [],
      attributes: {},
      price: 100,
      address: 'Fixture address',
    };
    stubFetch(
      'fetch',
      vi.fn(async (url: string, options?: { method?: string }) => {
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
        else if (options?.method === 'DELETE' || options?.method === 'PATCH')
          await new Promise<void>((done) => {
            finishMutation = done;
          });
        else if (url.endsWith('/collections/favorite'))
          value = { items: [card], cursor: null };
        else if (url.endsWith('/saved-searches'))
          value = {
            items: [{ id: 'saved-one', name: 'Saved fixture', definition: {} }],
            cursor: null,
          };
        else if (url.endsWith('/collections/compare')) {
          value = {
            items: [
              { ...card, id: 'compare-only', title: 'Comparison listing' },
            ],
            cursor: null,
          };
          await new Promise<void>((done) => {
            finishComparison = done;
          });
        }
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByRole('link', { name: 'Favorite listing' });
    if (mutation.startsWith('saved')) {
      fireEvent.click(
        screen.getByRole('button', { name: 'Сохранённые поиски' }),
      );
      await screen.findByText('Saved fixture');
    }
    fireEvent.click(
      screen.getByRole('button', {
        name:
          mutation === 'favorite-delete'
            ? 'Удалить'
            : mutation === 'saved-rename'
              ? 'Переименовать'
              : 'Удалить поиск',
      }),
    );
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Сравнение' }));
    await vi.waitFor(() => expect(finishComparison).toBeTypeOf('function'));
    if (mutation === 'favorite-delete') {
      await act(async () => {
        finishComparison!();
      });
      await act(async () => {
        finishMutation!();
      });
    } else {
      await act(async () => {
        finishMutation!();
      });
      await act(async () => {
        finishComparison!();
      });
    }
    expect(
      screen.getByRole('link', { name: 'Comparison listing' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Favorite listing' })).toBeNull();
  });
}

for (const delayed of ['open', 'page', 'send']) {
  test(`Late thread A ${delayed} preserves thread B messages, cursor and draft`, async () => {
    let release: (() => void) | undefined;
    stubFetch(
      'fetch',
      vi.fn(async (url: string, options?: { method?: string }) => {
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
        else if (url.endsWith('/account/threads'))
          value = {
            items: [
              { id: 'thread-a', listing_id: 'a' },
              { id: 'thread-b', listing_id: 'b' },
            ],
            cursor: null,
          };
        else if (url.includes('/thread-a/messages')) {
          value = {
            items: [
              {
                id: url.includes('?') ? 'older-a' : 'message-a',
                body: url.includes('?') ? 'Older A' : 'Thread A message',
                created_at: '2026-10-06T00:00:00Z',
              },
            ],
            cursor: 'page-a',
          };
          if (
            delayed === 'open' ||
            (delayed === 'page' && url.includes('?')) ||
            (delayed === 'send' && options?.method === 'POST')
          )
            await new Promise<void>((done) => {
              release = done;
            });
        } else if (url.includes('/thread-b/messages'))
          value = {
            items: [
              {
                id: 'message-b',
                body: 'Thread B message',
                created_at: '2026-10-06T00:00:00Z',
              },
            ],
            cursor: null,
          };
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByText('Buyer');
    fireEvent.click(screen.getByRole('button', { name: 'Сообщения' }));
    const buttons = await screen.findAllByRole('button', {
      name: 'Открыть переписку',
    });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    if (delayed !== 'open') {
      await screen.findByText('Thread A message', { exact: false });
      if (delayed === 'page')
        fireEvent.click(
          screen.getByRole('button', { name: 'Предыдущие сообщения' }),
        );
      else {
        fireEvent.change(screen.getByLabelText('Ответ'), {
          target: { value: 'A reply' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
      }
    }
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(buttons[1]!);
    await screen.findByText('Thread B message', { exact: false });
    expect((screen.getByLabelText('Ответ') as HTMLTextAreaElement).value).toBe(
      '',
    );
    fireEvent.change(screen.getByLabelText('Ответ'), {
      target: { value: 'B unsent draft' },
    });
    await act(async () => {
      release!();
    });
    expect(screen.getByText('Thread B message', { exact: false })).toBeTruthy();
    expect(screen.queryByText('Older A', { exact: false })).toBeNull();
    expect(screen.queryByText('Thread A message', { exact: false })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Предыдущие сообщения' }),
    ).toBeNull();
    expect((screen.getByLabelText('Ответ') as HTMLTextAreaElement).value).toBe(
      'B unsent draft',
    );
  });
}

for (const delay of ['read', 'threads', 'none']) {
  test(`Notification ${delay} completion respects current navigation`, async () => {
    let release: (() => void) | undefined;
    stubFetch(
      'fetch',
      vi.fn(async (url: string) => {
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
        else if (url.endsWith('/notifications'))
          value = {
            items: [
              {
                id: 'n-one',
                kind: 'message',
                thread_id: 'thread-a',
                read_at: null,
                created_at: '2026-10-14T00:00:00Z',
              },
            ],
            cursor: null,
          };
        else if (url.endsWith('/preferences')) value = { in_app: true };
        else if (url.endsWith('/n-one/read') && delay === 'read')
          await new Promise<void>((done) => {
            release = done;
          });
        else if (url.endsWith('/account/threads')) {
          value = {
            items: [{ id: 'thread-a', listing_id: 'a' }],
            cursor: null,
          };
          if (delay === 'threads' && !release)
            await new Promise<void>((done) => {
              release = done;
            });
        } else if (url.endsWith('/thread-a/messages'))
          value = {
            items: [
              {
                id: 'message-a',
                body: 'Notification thread message',
                created_at: '2026-10-06T00:00:00Z',
              },
            ],
            cursor: null,
          };
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByText('Buyer');
    fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Прочитать' }));
    if (delay === 'none') {
      await screen.findByText('Notification thread message', { exact: false });
      expect(
        screen
          .getByRole('button', { name: 'Сообщения' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
    } else {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      fireEvent.click(screen.getByRole('button', { name: 'Сравнение' }));
      await act(async () => {
        release!();
      });
      expect(
        screen
          .getByRole('button', { name: 'Сравнение' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      expect(screen.queryByRole('region', { name: 'Переписка' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Сообщения' }));
      await screen.findByRole('button', { name: 'Открыть переписку' });
      expect(
        screen.queryByText('Notification thread message', { exact: false }),
      ).toBeNull();
    }
  });
}

test('Successful send refreshes the selected thread and clears its submitted draft', async () => {
  let sent = false;
  stubFetch(
    'fetch',
    vi.fn(async (url: string, options?: { method?: string }) => {
      let value: unknown = { items: [], cursor: null };
      if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
      else if (url.endsWith('/account/threads'))
        value = { items: [{ id: 'thread-a', listing_id: 'a' }], cursor: null };
      else if (url.endsWith('/thread-a/messages')) {
        if (options?.method === 'POST') sent = true;
        value = {
          items: [
            {
              id: 'message-a',
              body: sent ? 'Updated message' : 'Initial message',
              created_at: '2026-10-06T00:00:00Z',
            },
          ],
          cursor: null,
        };
      }
      return { ok: true, json: async () => value };
    }),
  );
  render(<Account />);
  await screen.findByText('Buyer');
  fireEvent.click(screen.getByRole('button', { name: 'Сообщения' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Открыть переписку' }),
  );
  await screen.findByText('Initial message', { exact: false });
  fireEvent.change(screen.getByLabelText('Ответ'), {
    target: { value: 'A reply' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await screen.findByText('Updated message', { exact: false });
  expect((screen.getByLabelText('Ответ') as HTMLTextAreaElement).value).toBe(
    '',
  );
});

test('Selected thread pagination appends older messages and consumes its cursor', async () => {
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => {
      let value: unknown = { items: [], cursor: null };
      if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
      else if (url.endsWith('/account/threads'))
        value = { items: [{ id: 'thread-a', listing_id: 'a' }], cursor: null };
      else if (url.includes('/thread-a/messages'))
        value = {
          items: [
            {
              id: url.includes('?') ? 'older-a' : 'current-a',
              body: url.includes('?') ? 'Older message' : 'Current message',
              created_at: '2026-10-06T00:00:00Z',
            },
          ],
          cursor: url.includes('?') ? null : 'page-a',
        };
      return { ok: true, json: async () => value };
    }),
  );
  render(<Account />);
  await screen.findByText('Buyer');
  fireEvent.click(screen.getByRole('button', { name: 'Сообщения' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Открыть переписку' }),
  );
  await screen.findByText('Current message', { exact: false });
  fireEvent.click(screen.getByRole('button', { name: 'Предыдущие сообщения' }));
  await screen.findByText('Older message', { exact: false });
  expect(screen.getByText('Current message', { exact: false })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Предыдущие сообщения' }),
  ).toBeNull();
});

test('Account displays its permanent ID without rounding large numeric identifiers', async () => {
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/auth/me')
          ? {
              display_name: 'Buyer',
              public_id: '9007199254740993',
              role: 'buyer',
              email_verified_at: 'now',
              phone_verified_at: 'now',
            }
          : { items: [], cursor: null },
    })),
  );
  render(<Account />);
  expect(await screen.findByText('ID: 9007199254740993')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Мои объявления' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Мои объявления' })).toBeNull();
});

test.each([
  { role: 'agent', heading: 'Кабинет риелтора', canCreateAgency: false },
  { role: 'agency', heading: 'Кабинет агентства', canCreateAgency: true },
])(
  'Account opens the correct cabinet for $role',
  async ({ role, heading, canCreateAgency }) => {
    stubFetch('fetch', async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.endsWith('/auth/me'))
          return { id: '17', role, display_name: 'Seller', public_id: '17' };
        if (url.endsWith('/organizations')) return [];
        return { items: [], cursor: null };
      },
    }));
    render(<Account />);

    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Мои объявления' }).getAttribute('href'),
    ).toBe('/account/listings');
    expect(screen.getByRole('region', { name: 'Агентства' })).toBeTruthy();
    expect(Boolean(screen.queryByText('Публичный профиль агента'))).toBe(
      role === 'agent',
    );
    expect(
      Boolean(screen.queryByRole('button', { name: 'Создать агентство' })),
    ).toBe(canCreateAgency);
  },
);

test('an agency manager keeps exactly one editable personal profile when returning to the agent cabinet', async () => {
  stubFetch('fetch', async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.endsWith('/auth/me'))
        return {
          id: 'agent-one',
          public_id: '107',
          role: 'agent',
          display_name: 'Тестовый агент',
          registration_approval_state: 'approved',
          email_verified_at: '2026-10-01',
          phone_verified_at: '2026-10-01',
        };
      if (url.endsWith('/organizations'))
        return [
          {
            id: 'agency-one',
            name: 'Тестовое агентство',
            kind: 'agency',
            active: true,
            membership_role: 'admin',
            membership_active: true,
          },
        ];
      if (url.includes('/search/professional-profile'))
        return { profile: null };
      if (url.endsWith('/summary')) return { total: 0, sale: 0, rent: 0 };
      if (
        url.endsWith('/members') ||
        url.endsWith('/listing-subscriptions') ||
        url.endsWith('/links')
      )
        return [];
      return { items: [], cursor: null };
    },
  }));
  render(<Account />);
  const personal = 'Публичный профиль агента';
  const agency = 'Публичный профиль агентства';
  await screen.findByText(agency);
  fireEvent.click(screen.getByRole('button', { name: 'Подписки' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Профиль и подтверждение контактов' }),
  );
  expect(screen.queryByText(personal)).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Вернуться к разделам аккаунта' }),
  );
  await screen.findByText(agency);
  expect(screen.getAllByText(personal)).toHaveLength(1);
  const summary = screen.getByText(personal);
  fireEvent.click(summary);
  const name = await within(summary.closest('details')!).findByRole('textbox', {
    name: 'Публичное имя',
  });
  fireEvent.change(name, { target: { value: 'Новое публичное имя' } });
  fireEvent.click(screen.getByRole('button', { name: 'Избранное' }));
  expect(screen.getAllByText(personal)).toHaveLength(1);
  expect(screen.getAllByText(agency)).toHaveLength(1);
  expect(
    within(summary.closest('details')!).getByDisplayValue(
      'Новое публичное имя',
    ),
  ).toBe(name);
});

test('the listing link follows the selected agency in the cabinet', async () => {
  stubFetch('fetch', async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.endsWith('/auth/me'))
        return {
          id: '17',
          role: 'agency',
          display_name: 'Seller',
          public_id: '17',
        };
      if (url.endsWith('/organizations'))
        return [
          { id: 'agency-1', name: 'Город' },
          { id: 'agency-2', name: 'Квартал' },
        ].map((agency) => ({
          ...agency,
          kind: 'agency',
          active: true,
          membership_role: 'member',
          membership_active: true,
        }));
      return url.endsWith('/members') ? [] : { items: [], cursor: null };
    },
  }));
  render(<Account />);

  const link = await screen.findByRole('link', {
    name: 'Перейти к подаче объявления',
  });
  expect(link.getAttribute('href')).toBe(
    '/account/listings?agency=agency-1#new-listing',
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Агентство' }), {
    target: { value: 'agency-2' },
  });
  expect(link.getAttribute('href')).toBe(
    '/account/listings?agency=agency-2#new-listing',
  );
  expect(screen.queryByText('XML-выгрузки организации')).toBeNull();
});

test.each(['agency', 'developer'])(
  'a %s manager accesses the XML sources of the selected organization',
  async (role) => {
    const requests: string[] = [];
    stubFetch('fetch', async (url) => {
      requests.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (url.endsWith('/auth/me'))
            return {
              id: 'manager',
              role,
              display_name: 'Управляющий',
              email_verified_at: 'now',
              phone_verified_at: 'now',
              public_id: '7',
            };
          if (url.endsWith('/organizations'))
            return [
              {
                id: 'org-b',
                name: 'Проект',
                kind: role,
                active: true,
                membership_role: 'admin',
                membership_active: true,
              },
            ];
          if (url.endsWith('/members') || url.endsWith('/links')) return [];
          return { items: [], cursor: null };
        },
      };
    });
    render(<Account />);
    fireEvent.click(await screen.findByText('XML-выгрузки организации'));
    expect(
      await screen.findByRole('textbox', { name: 'Домклик' }),
    ).toBeTruthy();
    expect(requests).toContain('/api/v1/organizations/org-b/feeds/links');
    expect(screen.queryByText('Мои XML-выгрузки')).toBeNull();
  },
);

test.each([false, true])(
  'publication entry offers the correct next step when contacts verified: %s',
  async (verified) => {
    stubFetch('fetch', async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith('/auth/me')
          ? {
              role: 'owner',
              display_name: 'Owner',
              public_id: '17',
              email_verified_at: 'now',
              phone_verified_at: verified ? 'now' : null,
            }
          : { items: [], cursor: null },
    }));
    render(<Account continueListing />);
    await screen.findByRole('heading', { name: 'Кабинет собственника' });
    if (verified) {
      expect(
        screen.getByRole('link', { name: 'Продолжить подачу объявления' }),
      ).toBeTruthy();
    } else {
      expect(
        screen.queryByRole('region', { name: 'Мои объявления' }),
      ).toBeNull();
      expect(
        screen.queryByRole('link', { name: 'Продолжить подачу объявления' }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Подтвердить контакты для подачи' }),
      ).toBeTruthy();
    }
  },
);

test('a verified seller can retry unavailable counters and see confirmed zeros', async () => {
  let attempts = 0;
  const seller = {
    id: 'seller',
    role: 'owner',
    public_id: '18',
    display_name: 'Owner',
    email_verified_at: 'now',
    phone_verified_at: 'now',
    registration_approval_state: 'approved',
  };
  stubFetch('fetch', async (url) => {
    if (url.endsWith('/listings/summary')) {
      attempts++;
      return {
        ok: attempts > 1,
        status: attempts > 1 ? 200 : 503,
        json: async () => ({ total: 0, sale: 0, rent: 0 }),
      };
    }
    return {
      ok: true,
      json: async () =>
        url.endsWith('/auth/me') ? seller : { items: [], cursor: null },
    };
  });
  render(<Account />);
  const summary = within(
    await screen.findByRole('region', { name: 'Мои объявления' }),
  );
  await summary.findByRole('alert');
  expect(summary.queryByText('0')).toBeNull();
  fireEvent.click(summary.getByRole('button', { name: 'Повторить загрузку' }));
  await summary.findByText('Всего');
  expect(summary.getAllByText('0')).toHaveLength(3);
  expect(attempts).toBe(2);
});

test('a late listing summary cannot replace the next seller’s counters', async () => {
  const seller = {
    role: 'owner',
    email_verified_at: 'now',
    phone_verified_at: 'now',
    registration_approval_state: 'approved',
  };
  let release!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    release = resolve;
  });
  let summaryCalls = 0;
  stubFetch('fetch', async (url) => {
    let result: unknown = { items: [], cursor: null };
    if (url.endsWith('/auth/me')) {
      result = {
        ...seller,
        id: 'first',
        public_id: '1',
        display_name: 'First',
      };
    } else if (url.endsWith('/auth/login')) {
      result = {
        csrfToken: 'test-login',
        user: {
          ...seller,
          id: 'second',
          public_id: '2',
          display_name: 'Second',
        },
      };
    } else if (url.endsWith('/listings/summary')) {
      const request = ++summaryCalls;
      if (request === 1) await firstRequest;
      result =
        request === 1
          ? { total: 777, sale: 700, rent: 77 }
          : { total: 13, sale: 5, rent: 8 };
    }
    return { ok: true, status: 200, json: async () => result };
  });
  render(<Account />);
  const first = within(
    await screen.findByRole('region', { name: 'Мои объявления' }),
  );
  expect(first.getByRole('status').textContent).toContain('Загрузка');
  expect(first.queryByRole('definition')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  await screen.findByLabelText('Пароль');
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'qa@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'synthetic-long-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Войти$/ }));
  const next = within(
    await screen.findByRole('region', { name: 'Мои объявления' }),
  );
  await next.findByText('13');
  await act(async () => {
    release();
  });
  expect(next.getAllByRole('definition').map((dd) => dd.textContent)).toEqual([
    '13',
    '5',
    '8',
  ]);
  expect(next.queryByText('777')).toBeNull();
});

for (const state of ['pending', 'rejected']) {
  test(`${state} accounts do not load or expose private collections`, async () => {
    const requests: string[] = [];
    stubFetch('fetch', async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () =>
          url.endsWith('/auth/me')
            ? {
                display_name: 'Applicant',
                public_id: '17',
                role: 'agency',
                email_verified_at: 'now',
                phone_verified_at: 'now',
                registration_approval_state: state,
              }
            : { items: [], cursor: null },
      };
    });
    render(<Account />);
    await screen.findByText('Applicant');
    expect(
      screen.queryByRole('navigation', { name: 'Разделы аккаунта' }),
    ).toBeNull();
    expect(screen.queryByRole('link', { name: 'Мои объявления' })).toBeNull();
    expect(requests.some((url) => url.includes('/account/'))).toBe(false);
    expect(requests.some((url) => url.endsWith('/listings/summary'))).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeTruthy();
  });
}

test.each([
  ['owner', 'Кабинет собственника'],
  ['agent', 'Кабинет риелтора'],
  ['agency', 'Кабинет агентства'],
])(
  'Registration opens the %s cabinet when verification delivery is unavailable',
  async (roleCode, heading) => {
    let submitted: Record<string, unknown> | undefined;
    stubFetch('fetch', async (url, init) => {
      if (url.endsWith('/auth/me'))
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: 'Unauthorized' }),
        };
      if (url.endsWith('/auth/register')) {
        submitted = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({ verificationDelivery: 'unavailable' }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          csrfToken: 'fixture',
          user: {
            display_name: 'Applicant',
            role: roleCode,
            public_id: '18',
            registration_approval_state: 'pending',
          },
        }),
      };
    });
    render(<Account />);
    fireEvent.click(await screen.findByRole('button', { name: 'Регистрация' }));
    const role = screen.getByLabelText('Кто вы?') as HTMLSelectElement;
    expect(role.value).toBe('');
    expect(role.required).toBe(true);
    const roleHelp = screen.getByText(/Покупаете или арендуете/);
    expect(role.getAttribute('aria-describedby')).toBe(roleHelp.id);
    expect(roleHelp.textContent).toMatch(
      /Размещаете свой\s+объект — «Собственник»/,
    );
    expect(roleHelp.textContent).toContain('Работаете риелтором — «Агент»');
    expect(roleHelp.textContent).toContain(
      'Представляете агентство — «Агентство»',
    );
    expect(roleHelp.textContent).toMatch(
      /строительную компанию —\s+«Застройщик»/,
    );
    expect(Array.from(role.options).map((option) => option.value)).toEqual([
      '',
      'buyer',
      'owner',
      'agent',
      'agency',
      'developer',
    ]);
    fireEvent.change(screen.getByLabelText('Кто вы?'), {
      target: { value: roleCode },
    });
    fireEvent.change(screen.getByLabelText('Имя'), {
      target: { value: 'Applicant' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Пароль'), {
      target: { value: 'fixture-long-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Создать и войти' }));
    await screen.findByRole('heading', { name: heading });
    expect(submitted?.role).toBe(roleCode);
    expect(
      await screen.findByText(
        /Аккаунт создан. Не удалось подтвердить отправку письма/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('navigation', { name: 'Разделы аккаунта' }),
    ).toBeNull();
  },
);

test('Profile refresh unlocks approved collections and ignores a response after logout', async () => {
  let state = 'pending';
  let release: (() => void) | undefined;
  let delay = false;
  const requests: string[] = [];
  stubFetch('fetch', async (url) => {
    requests.push(url);
    if (url.endsWith('/auth/me')) {
      const value = {
        display_name: 'Applicant',
        public_id: '17',
        registration_approval_state: state,
      };
      if (delay)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { ok: true, json: async () => value };
    }
    return { ok: true, json: async () => ({ items: [], cursor: null }) };
  });
  render(<Account />);
  await screen.findByText('Applicant');
  state = 'approved';
  fireEvent.click(screen.getByRole('button', { name: 'Обновить профиль' }));
  await screen.findByRole('navigation', { name: 'Разделы аккаунта' });
  expect(
    requests.filter((url) => url.includes('/account/collections/')),
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Профиль и подтверждение контактов' }),
  );
  delay = true;
  fireEvent.click(screen.getByRole('button', { name: 'Обновить профиль' }));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  await screen.findByRole('heading', { name: 'Войти в аккаунт' });
  await act(async () => {
    release!();
  });
  expect(screen.queryByText('Applicant')).toBeNull();
  expect(
    requests.filter((url) => url.includes('/account/collections/')),
  ).toHaveLength(1);
});

for (const operation of ['logout', 'refresh']) {
  for (const status of [401, 403, 503]) {
    test(`${operation} HTTP ${status} ${status === 401 ? 'clears an expired identity' : 'retains the authenticated identity'}`, async () => {
      let fail = false;
      stubFetch('fetch', async (url) => {
        if (
          fail &&
          url.endsWith(operation === 'logout' ? '/auth/logout' : '/auth/me')
        )
          return { ok: false, status, json: async () => ({}) };
        return {
          ok: true,
          json: async () =>
            url.endsWith('/auth/me')
              ? {
                  display_name: 'Applicant',
                  public_id: '21',
                  registration_approval_state: 'pending',
                }
              : { items: [], cursor: null },
        };
      });
      render(<Account />);
      await screen.findByText('Applicant');
      sessionStorage.setItem('raui_csrf', 'expired-token');
      fail = true;
      fireEvent.click(
        screen.getByRole('button', {
          name: operation === 'logout' ? 'Выйти' : 'Обновить профиль',
        }),
      );
      if (status === 401) {
        await screen.findByRole('heading', { name: 'Войти в аккаунт' });
        expect(screen.queryByText('Applicant')).toBeNull();
        expect(sessionStorage.getItem('raui_csrf')).toBe('');
        expect(screen.getByRole('alert').textContent).toContain('Войдите');
      } else {
        await screen.findByText(
          'Не удалось выполнить запрос. Попробуйте ещё раз.',
        );
        expect(screen.getByText('Applicant')).toBeTruthy();
      }
    });
  }
}

test('Late expired profile refresh cannot sign out a new identity', async () => {
  let initial = true;
  let release: (() => void) | undefined;
  stubFetch('fetch', async (url) => {
    if (url.endsWith('/auth/me')) {
      if (initial) {
        initial = false;
        return {
          ok: true,
          json: async () => ({
            display_name: 'Identity A',
            public_id: '21',
            registration_approval_state: 'pending',
          }),
        };
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.endsWith('/auth/login'))
      return {
        ok: true,
        json: async () => ({
          csrfToken: 'new-session',
          user: { display_name: 'Identity B', public_id: '22' },
        }),
      };
    return { ok: true, json: async () => ({ items: [], cursor: null }) };
  });
  render(<Account />);
  await screen.findByText('Identity A');
  const expiredOldProfile = profileCallbacks.expire;
  fireEvent.click(screen.getByRole('button', { name: 'Обновить профиль' }));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  await screen.findByRole('heading', { name: 'Войти в аккаунт' });
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'b@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'fixture-long-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByText('Identity B');
  await act(async () => {
    release!();
  });
  expect(screen.getByText('Identity B')).toBeTruthy();
  await act(async () => {
    expiredOldProfile!();
  });
  expect(screen.getByText('Identity B')).toBeTruthy();
  expect(sessionStorage.getItem('raui_csrf')).toBe('new-session');
});

test('Current profile session-expiry callback clears identity and shows login', async () => {
  stubFetch('fetch', async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith('/auth/me')
        ? {
            display_name: 'Applicant',
            public_id: '21',
            registration_approval_state: 'pending',
          }
        : { items: [], cursor: null },
  }));
  render(<Account />);
  await screen.findByText('Applicant');
  await act(async () => {
    profileCallbacks.expire!();
  });
  expect(screen.getByRole('heading', { name: 'Войти в аккаунт' })).toBeTruthy();
  expect(screen.queryByText('Applicant')).toBeNull();
});

test('saved searches show distinct escaped summaries while retaining original reopen and rename definitions', async () => {
  const definitions = [
    { q: '<img src=x onerror=alert(1)> & #', price: { min: 0, max: 100 } },
    {
      regionCode: 'moscow',
      locality: 'Москва',
      attributes: { rooms: { max: 2 } },
    },
  ];
  const fetcher = vi.fn(async (url: string, options?: { method?: string }) => {
    let value: unknown = { items: [], cursor: null };
    if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
    if (url.endsWith('/saved-searches') && options?.method === 'GET')
      value = {
        items: definitions.map((definition, i) => ({
          id: String(i),
          name: 'Одинаковое имя',
          definition,
        })),
        cursor: null,
      };
    return { ok: true, json: async () => value };
  });
  stubFetch('fetch', fetcher);
  const { container } = render(<Account />);
  await screen.findByText('Buyer');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранённые поиски' }));
  await screen.findByText(
    'Поиск: <img src=x onerror=alert(1)> & # · Цена: от 0 до 100 ₽',
  );
  expect(
    screen.getByText('Регион: moscow · Город: Москва · Комнаты: до 2'),
  ).toBeTruthy();
  expect(container.querySelector('img')).toBeNull();
  const links = screen.getAllByRole('link', { name: 'Открыть поиск' });
  links.forEach((link, i) =>
    expect(link.getAttribute('href')).toBe(
      '/search?definition=' +
        encodeURIComponent(JSON.stringify(definitions[i])),
    ),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Переименовать' })[0]!);
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, options]) =>
          url.endsWith('/saved-searches/0') && options?.method === 'PATCH',
      ),
    ).toBe(true),
  );
  const call = fetcher.mock.calls.find(
    ([url, options]) =>
      url.endsWith('/saved-searches/0') && options?.method === 'PATCH',
  )!;
  expect(JSON.parse((call[1] as { body: string }).body).definition).toEqual(
    definitions[0],
  );
});

for (const available of [false, true]) {
  test(`Subscription availability ${available} uses a separate inbox action`, async () => {
    const requests: string[] = [];
    stubFetch(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
        else if (url.endsWith('/notifications'))
          value = {
            items: [
              {
                id: '42',
                kind: 'subscription.listing.availability',
                listing_id: 'listing-one',
                event: { kind: 'availability', available },
                read_at: null,
                created_at: '2026-10-14T00:00:00Z',
              },
            ],
            cursor: null,
          };
        else if (url.endsWith('/preferences')) value = { in_app: true };
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByText('Buyer');
    fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
    await screen.findByText(
      available ? 'Объявление снова доступно' : 'Объявление больше недоступно',
    );
    if (available)
      expect(
        screen
          .getByRole('link', { name: 'Открыть объявление' })
          .getAttribute('href'),
      ).toBe('/listings/listing-one');
    else
      expect(
        screen.queryByRole('link', { name: 'Открыть объявление' }),
      ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Отметить прочитанным' }),
    );
    await vi.waitFor(() =>
      expect(requests.some((url) => url.endsWith('/42/read'))).toBe(true),
    );
    expect(requests.some((url) => url.includes('/account/threads'))).toBe(
      false,
    );
    expect(
      screen
        .getByRole('button', { name: 'Уведомления' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });
}
test('Empty filtered notification page retains its advancing cursor', async () => {
  const requests: string[] = [];
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      let value: unknown = { items: [], cursor: null };
      if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
      else if (url.endsWith('/notifications'))
        value = { items: [], cursor: '42' };
      else if (url.endsWith('/notifications?cursor=42'))
        value = {
          items: [
            {
              id: '41',
              kind: 'subscription.listing.availability',
              listing_id: 'listing-two',
              event: { kind: 'availability', available: false },
              read_at: null,
              created_at: '2026-10-14T00:00:00Z',
            },
          ],
          cursor: null,
        };
      else if (url.endsWith('/preferences')) value = { in_app: true };
      return { ok: true, json: async () => value };
    }),
  );
  render(<Account />);
  await screen.findByText('Buyer');
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
  await screen.findByText('Объявление больше недоступно');
  expect(requests.some((url) => url.endsWith('/notifications?cursor=42'))).toBe(
    true,
  );
});
for (const [priceMinor, expected] of [
  [9900, 'Цена снизилась до 99,00 ₽'],
  [9007199254740987, 'Цена снизилась до 90 071 992 547 409,87 ₽'],
] as const) {
  test(`Price-drop inbox preserves exact minor units ${priceMinor}`, async () => {
    stubFetch(
      'fetch',
      vi.fn(async (url: string) => {
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
        else if (url.endsWith('/notifications'))
          value = {
            items: [
              {
                id: '42',
                kind: 'subscription.listing.price_drop',
                listing_id: 'listing-one',
                event: {
                  kind: 'price_drop',
                  previousPriceMinor: 9007199254740991,
                  priceMinor,
                },
                read_at: null,
                created_at: '2026-10-14T00:00:00Z',
              },
            ],
            cursor: null,
          };
        else if (url.endsWith('/preferences')) value = { in_app: true };
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByText('Buyer');
    fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
    const price = await screen.findByText(/Цена снизилась до/);
    expect(price.textContent?.replace(/\s/g, ' ')).toBe(expected);
  });
}
test('Subscription stale mark-read failure preserves inbox navigation and unread action', async () => {
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => {
      let value: unknown = { items: [], cursor: null };
      if (url.endsWith('/auth/me')) value = { display_name: 'Buyer' };
      else if (url.endsWith('/notifications'))
        value = {
          items: [
            {
              id: '42',
              kind: 'subscription.listing.availability',
              listing_id: 'listing-one',
              event: { kind: 'availability', available: false },
              read_at: null,
              created_at: '2026-10-14T00:00:00Z',
            },
          ],
          cursor: null,
        };
      else if (url.endsWith('/preferences')) value = { in_app: true };
      else if (url.endsWith('/42/read'))
        return {
          ok: false,
          status: 404,
          json: async () => ({ message: 'Уведомление недоступно' }),
        };
      return { ok: true, json: async () => value };
    }),
  );
  render(<Account />);
  await screen.findByText('Buyer');
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Отметить прочитанным' }),
  );
  await screen.findByText('Объект недоступен.');
  expect(
    screen
      .getByRole('button', { name: 'Уведомления' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(
    (
      screen.getByRole('button', {
        name: 'Отметить прочитанным',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
for (const delayed of ['notifications', 'preferences'])
  test(`Late subscription ${delayed} response cannot leak content or cursor across identities`, async () => {
    let identity = 'A';
    let release: (() => void) | undefined;
    stubFetch(
      'fetch',
      vi.fn(async (url: string) => {
        let value: unknown = { items: [], cursor: null };
        if (url.endsWith('/auth/me')) value = { display_name: 'Identity A' };
        else if (url.endsWith('/auth/logout')) identity = '';
        else if (url.endsWith('/auth/login')) {
          identity = 'B';
          value = {
            csrfToken: 'synthetic-csrf-B',
            user: { display_name: 'Identity B' },
          };
        } else if (url.endsWith('/notifications') && identity === 'A') {
          value = {
            items: [
              {
                id: '42',
                kind: 'subscription.listing.price_drop',
                listing_id: 'private-A',
                event: {
                  kind: 'price_drop',
                  previousPriceMinor: 10000,
                  priceMinor: 9900,
                },
                read_at: null,
                created_at: '2026-10-14T00:00:00Z',
              },
            ],
            cursor: '41',
          };
          if (delayed === 'notifications')
            await new Promise<void>((done) => {
              release = done;
            });
        } else if (url.endsWith('/preferences')) {
          value = { in_app: true };
          if (identity === 'A' && delayed === 'preferences')
            await new Promise<void>((done) => {
              release = done;
            });
        }
        return { ok: true, json: async () => value };
      }),
    );
    render(<Account />);
    await screen.findByText('Identity A');
    fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await screen.findByRole('heading', { name: 'Войти в аккаунт' });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'b@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Пароль'), {
      target: { value: 'synthetic-long-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByText('Identity B');
    await act(async () => {
      release!();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
    await screen.findByText('Новых уведомлений нет.');
    expect(screen.queryByText(/Цена снизилась до/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });
