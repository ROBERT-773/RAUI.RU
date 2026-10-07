import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SearchProduct from './search';
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
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
  navigation.replace.mockClear();
  vi.unstubAllGlobals();
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
  const fetch = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url === '/api/v1/regions'
        ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: false, status: 503 },
    );
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

test('catalogue region change clears geographic criteria and survives submit and save', async () => {
  const fetch = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url === '/api/v1/regions'
        ? {
            items: [
              { code: 'moscow', name: 'Москва' },
              { code: 'moscow_oblast', name: 'Московская область' },
            ],
          }
        : url.includes('/attributes')
          ? []
          : { items: [], total: 0, cursor: null, facets: {} },
  }));
  vi.stubGlobal('fetch', fetch);
  render(
    <SearchProduct
      initialDefinition={{
        locality: 'Москва',
        district: 'ЦАО',
        cursor: 'old',
        bounds: [37, 55, 38, 56],
        polygon: [
          [37, 55],
          [38, 55],
          [38, 56],
          [37, 55],
        ],
        attributes: {
          metro: 'Арбатская',
          okrug: 'ЦАО',
          highway: 'М4',
          highway_distance: { max: 10 },
          rooms: { min: 2 },
        },
        q: 'дом',
        price: { max: 5000000 },
      }}
    />,
  );
  const select = await screen.findByLabelText('Регион');
  await screen.findByRole('option', { name: 'Московская область' });
  fireEvent.change(select, { target: { value: 'moscow_oblast' } });
  await vi.waitFor(() =>
    expect((screen.getByLabelText('Город') as HTMLInputElement).value).toBe(''),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Сохранить поиск' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поиск' }));
  await vi.waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url]) => url === '/api/v1/account/saved-searches',
      ),
    ).toBe(true),
  );
  const [, request] = fetch.mock.calls.find(
    ([url]) => url === '/api/v1/account/saved-searches',
  )!;
  const saved = JSON.parse(request.body).definition;
  expect(saved.regionCode).toBe('moscow_oblast');
  const target = navigation.replace.mock.calls.at(-1)![0] as string;
  const restored = JSON.parse(
    new URL(target, 'https://raui.test').searchParams.get('definition')!,
  );
  expect(restored).toEqual(saved);
  for (const key of ['locality', 'district', 'cursor', 'bounds', 'polygon'])
    expect(saved[key]).toBeUndefined();
  for (const key of ['metro', 'okrug', 'highway', 'highway_distance'])
    expect(saved.attributes[key]).toBeUndefined();
  expect(saved.q).toBe('дом');
  expect(saved.price.max).toBe(5000000);
  expect(saved.attributes.rooms.min).toBe(2);
});

test('catalogue failure is explicit and offers no invented regions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => ({
      ok: url !== '/api/v1/regions',
      status: 503,
      json: async () =>
        url.includes('/attributes')
          ? []
          : { items: [], total: 0, cursor: null, facets: {} },
    })),
  );
  render(<SearchProduct />);
  expect(await screen.findByText('Не удалось загрузить регионы.')).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Москва' })).toBeNull();
});
