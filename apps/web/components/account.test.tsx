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
    vi.stubGlobal(
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
  vi.stubGlobal(
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
    vi.stubGlobal(
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
