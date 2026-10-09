import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SearchProduct from './search';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
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
});
test('loading → empty results and accessible filters', async () => {
  stubFetch(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0, cursor: null, facets: {} }),
    }),
  );
  render(<SearchProduct />);
  expect(screen.getByRole('status').textContent).toContain('Загрузка');
  expect(
    screen
      .getByRole('button', { name: 'Сохранить поиск' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(await screen.findByText(/Объявления не найдены/)).toBeTruthy();
  expect(screen.getByLabelText('Цена до')).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: 'Сохранить поиск' })
      .hasAttribute('disabled'),
  ).toBe(false);
});
test('API error is actionable and retry reissues the request', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  stubFetch('fetch', fetch);
  render(<SearchProduct />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await vi.waitFor(() =>
    expect(
      fetch.mock.calls.filter((call) => call[0] === '/api/v1/search'),
    ).toHaveLength(2),
  );
});
