import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SearchProduct from './search';
import type { SearchDefinition } from '@raui/types/product';
const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/search');
});
function captureSearch() {
  const fetch = vi.fn<
    (
      url: string,
      options?: RequestInit,
    ) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
  >(async (url) => ({
    ok: true,
    json: async () =>
      url.includes('/categories/')
        ? []
        : { items: [], total: 0, cursor: null, facets: {} },
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function routedDefinition() {
  const target = replace.mock.calls.at(-1)![0] as string;
  const url = new URL(target, window.location.origin);
  return {
    url,
    definition: JSON.parse(
      url.searchParams.get('definition')!,
    ) as SearchDefinition,
  };
}
test('same-route navigation restores the executed definition, visible fields and mode', async () => {
  const fetch = captureSearch();
  const view = render(
    <SearchProduct initialDefinition={{ q: 'first', category: 'apartment' }} />,
  );
  await screen.findByText(/Объявления не найдены/);
  fireEvent.change(screen.getByLabelText('Поиск'), {
    target: { value: 'unsaved draft' },
  });
  const saved: SearchDefinition = {
    q: 'saved',
    category: 'house',
    dealType: 'long_rent',
    locality: 'Москва',
    price: { min: 0, max: 100000 },
    sort: 'price_desc',
    attributes: { rooms: { min: 2, max: 4 }, area: { max: 90 } },
  };
  // Keep the same rendered SearchProduct instance, as Next same-route navigation does.
  view.rerender(<SearchProduct initialDefinition={saved} initialMode="map" />);
  await vi.waitFor(() =>
    expect(
      fetch.mock.calls.filter(([url]) => url === '/api/v1/search').at(-1)?.[1],
    ).toMatchObject({ body: JSON.stringify(saved) }),
  );
  expect(screen.getByLabelText('Поиск')).toHaveProperty('value', 'saved');
  expect(screen.getByLabelText('Объект')).toHaveProperty('value', 'house');
  expect(screen.getByLabelText('Сделка')).toHaveProperty('value', 'long_rent');
  expect(screen.getByLabelText('Город')).toHaveProperty('value', 'Москва');
  expect(screen.getByLabelText('Цена от')).toHaveProperty('value', '0');
  expect(screen.getByLabelText('Цена до')).toHaveProperty('value', '100000');
  expect(screen.getByLabelText('Сортировка')).toHaveProperty(
    'value',
    'price_desc',
  );
  expect(screen.getByLabelText('Комнат от')).toHaveProperty('value', '2');
  expect(screen.getByLabelText('Комнат до')).toHaveProperty('value', '4');
  expect(screen.getByLabelText('Площадь от, м²')).toHaveProperty('value', '');
  expect(screen.getByLabelText('Площадь до, м²')).toHaveProperty('value', '90');
  expect(
    screen.getByRole('button', { name: 'Карта' }).getAttribute('aria-pressed'),
  ).toBe('true');
});
for (const attributes of [
  { rooms: { min: 2, max: 4 }, area: { min: 40.5, max: 90.5 } },
  { rooms: { max: 3 }, area: { max: 70 } },
]) {
  test(`unchanged submit preserves room/area ranges ${JSON.stringify(attributes)} in URL and executed definition`, async () => {
    const fetch = captureSearch();
    const view = render(<SearchProduct initialDefinition={{ attributes }} />);
    await screen.findByText(/Объявления не найдены/);
    expect(
      (
        screen.getByLabelText('Площадь от, м²') as HTMLInputElement
      ).checkValidity(),
    ).toBe(true);
    expect(
      (
        screen.getByLabelText('Площадь до, м²') as HTMLInputElement
      ).checkValidity(),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    const { url, definition } = routedDefinition();
    expect(definition.attributes).toEqual(attributes);
    // Execute the new definition only after navigation supplies the URL state.
    expect(
      fetch.mock.calls.filter(([path]) => path === '/api/v1/search'),
    ).toHaveLength(1);
    window.history.replaceState({}, '', url);
    view.rerender(<SearchProduct initialDefinition={definition} />);
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls
          .filter(([path]) => path === '/api/v1/search')
          .at(-1)?.[1],
      ).toMatchObject({ body: JSON.stringify(definition) }),
    );
    expect(screen.getByLabelText('Комнат до')).toHaveProperty(
      'value',
      String(attributes.rooms.max),
    );
    expect(screen.getByLabelText('Площадь до, м²')).toHaveProperty(
      'value',
      String(attributes.area.max),
    );
  });
}
test('range edits preserve the other endpoint, accept zero and clear only the intended bounds', async () => {
  captureSearch();
  const view = render(
    <SearchProduct
      initialDefinition={{
        attributes: { rooms: { min: 2, max: 4 }, area: { min: 40, max: 90 } },
      }}
    />,
  );
  await screen.findByText(/Объявления не найдены/);
  fireEvent.change(screen.getByLabelText('Комнат от'), {
    target: { value: '0' },
  });
  fireEvent.change(screen.getByLabelText('Площадь от, м²'), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
  let current = routedDefinition();
  expect(current.definition.attributes).toEqual({
    rooms: { min: 0, max: 4 },
    area: { max: 90 },
  });
  window.history.replaceState({}, '', current.url);
  view.rerender(<SearchProduct initialDefinition={current.definition} />);
  await screen.findByText(/Объявления не найдены/);
  for (const label of ['Комнат от', 'Комнат до', 'Площадь до, м²'])
    fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
  current = routedDefinition();
  expect(current.definition.attributes).toEqual({});
});
test('a late previous-search response cannot replace the new route or finish its loading', async () => {
  const replies: ((value: unknown) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: () =>
        url.includes('/categories/')
          ? Promise.resolve([])
          : new Promise((resolve) => replies.push(resolve)),
    })),
  );
  const view = render(<SearchProduct initialDefinition={{ q: 'old' }} />);
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  view.rerender(<SearchProduct initialDefinition={{ q: 'new' }} />);
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  replies[0]!({ items: [], total: 999, facets: {} });
  await vi.waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Загрузка'),
  );
  expect(screen.queryByText(/999/)).toBeNull();
  replies[1]!({ items: [], total: 7, facets: {} });
  expect(await screen.findByText('Найдено около 7 объявлений')).toBeTruthy();
});
test('loading → empty results and accessible filters', async () => {
  vi.stubGlobal(
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
  vi.stubGlobal('fetch', fetch);
  render(<SearchProduct />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await vi.waitFor(() =>
    expect(
      fetch.mock.calls.filter((call) => call[0] === '/api/v1/search'),
    ).toHaveLength(2),
  );
});
