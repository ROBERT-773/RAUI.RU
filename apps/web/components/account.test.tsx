import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import Account from './account';
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
