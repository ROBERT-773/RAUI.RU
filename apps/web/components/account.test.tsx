import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
            items: [{ id: 'n-one', thread_id: 'thread-a', read_at: null }],
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
          ? { display_name: 'Buyer', public_id: '9007199254740993' }
          : { items: [], cursor: null },
    })),
  );
  render(<Account />);
  expect(await screen.findByText('ID: 9007199254740993')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeTruthy();
  });
}

test('Owner registration survives unavailable verification delivery and opens onboarding', async () => {
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
          display_name: 'Owner',
          public_id: '18',
          registration_approval_state: 'pending',
        },
      }),
    };
  });
  render(<Account />);
  fireEvent.click(await screen.findByRole('button', { name: 'Регистрация' }));
  fireEvent.change(screen.getByLabelText('Тип аккаунта'), {
    target: { value: 'owner' },
  });
  fireEvent.change(screen.getByLabelText('Имя'), {
    target: { value: 'Owner' },
  });
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'owner@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'fixture-long-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Создать и войти' }));
  await screen.findByText('Owner');
  expect(submitted?.role).toBe('owner');
  expect(
    await screen.findByText(
      /Аккаунт создан. Не удалось подтвердить отправку письма/,
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole('navigation', { name: 'Разделы аккаунта' }),
  ).toBeNull();
});

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
