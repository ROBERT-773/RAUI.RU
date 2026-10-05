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
