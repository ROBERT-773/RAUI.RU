import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  render,
  screen,
  cleanup,
  fireEvent,
} from '@testing-library/react';
import SearchProduct from './search';
import type { SearchDefinition } from '@raui/types/product';
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const { replace } = navigation;
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
  navigation.replace.mockClear();
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
  stubFetch('fetch', fetch);
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
async function submitReadySearch() {
  const submit = screen.getByRole('button', { name: 'Найти' });
  await vi.waitFor(() => expect(submit).toHaveProperty('disabled', false));
  fireEvent.click(submit);
}
test('uses the archived search heading and preserves the title for a regional catalog', () => {
  captureSearch();
  const view = render(<SearchProduct />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Расширенный поиск',
  );
  view.rerender(<SearchProduct title="Квартиры в Москве" />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Квартиры в Москве',
  );
});

test('keeps unsaved search filters and returns focus when a guest closes favorites', async () => {
  captureSearch();
  window.history.replaceState({}, '', '/search?mode=list');
  render(<SearchProduct />);
  const price = screen.getByLabelText('Цена от') as HTMLInputElement;
  fireEvent.change(price, { target: { value: '2500000' } });
  const link = screen.getByRole('link', { name: 'Избранное и аккаунт' });
  fireEvent.click(link);
  expect(
    screen.getByRole('dialog', { name: 'Вход или регистрация' }),
  ).toBeTruthy();
  expect(window.location.search).toBe('?mode=list');
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(link);
  expect(price.value).toBe('2500000');
});

test('short rental guest count uses a minimum capacity and clears on other deals', async () => {
  captureSearch();
  render(<SearchProduct initialDefinition={{ dealType: 'short_rent' }} />);
  expect(screen.getByLabelText('Цена за сутки от')).toBeTruthy();
  expect(screen.getByLabelText('Цена за сутки до')).toBeTruthy();
  expect(screen.getByLabelText('Число гостей').closest('details')).toBeNull();
  fireEvent.change(screen.getByLabelText('Число гостей'), {
    target: { value: '3' },
  });
  fireEvent.change(screen.getByLabelText('Заезд'), {
    target: { value: '2026-12-30' },
  });
  fireEvent.change(screen.getByLabelText('Выезд'), {
    target: { value: '2027-01-02' },
  });
  await submitReadySearch();
  expect(routedDefinition().definition.attributes?.guest_capacity).toEqual({
    min: 3,
  });
  expect(routedDefinition().definition.attributes).toMatchObject({
    rental_available_from: { max: 20261230 },
    rental_available_until: { min: 20270102 },
    rental_minimum_nights: { max: 3 },
  });
  fireEvent.change(screen.getByLabelText('Сделка'), {
    target: { value: 'long_rent' },
  });
  expect(screen.queryByLabelText('Число гостей')).toBeNull();
  await submitReadySearch();
  expect(routedDefinition().definition.attributes).not.toHaveProperty(
    'guest_capacity',
  );
});
test('short rental dates restore from a link and reject a reversed stay', async () => {
  captureSearch();
  render(
    <SearchProduct
      initialDefinition={{
        dealType: 'short_rent',
        attributes: {
          rental_available_from: { max: 20261230 },
          rental_available_until: { min: 20270102 },
          rental_minimum_nights: { max: 3 },
        },
      }}
    />,
  );
  expect(screen.getByLabelText('Заезд')).toHaveProperty('value', '2026-12-30');
  expect(screen.getByLabelText('Выезд')).toHaveProperty('value', '2027-01-02');

  fireEvent.change(screen.getByLabelText('Выезд'), {
    target: { value: '2026-12-29' },
  });
  await submitReadySearch();
  expect(screen.getByText(/Выезд должен быть позже заезда/)).toBeTruthy();
  expect(replace).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Сделка'), {
    target: { value: 'long_rent' },
  });
  await submitReadySearch();
  for (const code of [
    'rental_available_from',
    'rental_available_until',
    'rental_minimum_nights',
  ]) {
    expect(routedDefinition().definition.attributes ?? {}).not.toHaveProperty(
      code,
    );
  }
});
test('long rental utilities filter restores explicit false and clears on sale', async () => {
  captureSearch();
  render(
    <SearchProduct
      initialDefinition={{
        dealType: 'long_rent',
        attributes: { utilities_included: false },
      }}
    />,
  );
  const field = screen.getByLabelText('Коммунальные платежи включены');
  expect(field).toHaveProperty('value', 'false');
  fireEvent.change(field, { target: { value: 'true' } });
  await submitReadySearch();
  expect(routedDefinition().definition.attributes?.utilities_included).toBe(
    true,
  );

  fireEvent.change(screen.getByLabelText('Сделка'), {
    target: { value: 'sale' },
  });
  expect(screen.queryByLabelText('Коммунальные платежи включены')).toBeNull();
  await submitReadySearch();
  expect(routedDefinition().definition.dealType).toBe('sale');
  expect(routedDefinition().definition.attributes).not.toHaveProperty(
    'utilities_included',
  );
});
test('pending or failed advanced lookup blocks form submission until retry safely restores saved attributes', async () => {
  const replies: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: () =>
        url.includes('/categories/')
          ? new Promise((resolve, reject) => replies.push({ resolve, reject }))
          : Promise.resolve({
              items: [],
              total: 0,
              totalIsEstimate: false,
              cursor: null,
              facets: {},
            }),
    })),
  );
  const view = render(
    <SearchProduct
      initialDefinition={{
        category: 'apartment',
        attributes: {
          elevator: false,
          floor: { max: 8 },
          unseen: 'saved',
        },
      }}
    />,
  );
  await screen.findByText(/Объявления не найдены/);
  const form = view.container.querySelector('form')!;
  fireEvent.submit(form);
  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Найти' })).toHaveProperty(
    'disabled',
    true,
  );
  await act(async () => replies[0]!.reject(new Error('unavailable')));
  fireEvent.submit(form);
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Повторить.*фильтр/ }));
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  await act(async () =>
    replies[1]!.resolve([
      { code: 'elevator', name: 'Лифт', kind: 'boolean', options: [] },
      { code: 'floor', name: 'Этаж', kind: 'number', options: [] },
    ]),
  );
  expect(screen.getByRole('button', { name: 'Найти' })).toHaveProperty(
    'disabled',
    false,
  );
  fireEvent.submit(form);
  expect(routedDefinition().definition.attributes).toEqual({
    elevator: false,
    floor: { max: 8 },
    unseen: 'saved',
  });
  fireEvent.change(screen.getByLabelText('Лифт'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('До'), { target: { value: '' } });
  fireEvent.submit(form);
  expect(routedDefinition().definition.attributes).toEqual({ unseen: 'saved' });
});
test('category submission waits for current fields and visibly removes prior-category attributes', async () => {
  const replies: ((value: unknown) => void)[] = [];
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: () =>
        url.includes('/categories/')
          ? new Promise((resolve) => replies.push(resolve))
          : Promise.resolve({
              items: [],
              total: 0,
              totalIsEstimate: false,
              cursor: null,
              facets: {},
            }),
    })),
  );
  const view = render(
    <SearchProduct
      initialDefinition={{
        category: 'apartment',
        attributes: { elevator: false, rooms: { min: 2, max: 4 } },
      }}
    />,
  );
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  await act(async () =>
    replies[0]!([
      { code: 'elevator', name: 'Лифт', kind: 'boolean', options: [] },
    ]),
  );
  fireEvent.change(screen.getByLabelText('Объект'), {
    target: { value: 'house' },
  });
  fireEvent.submit(view.container.querySelector('form')!);
  expect(replace).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Лифт')).toBeNull();
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  await act(async () =>
    replies[1]!([
      { code: 'elevator', name: 'Лифт', kind: 'boolean', options: [] },
    ]),
  );
  expect(screen.getByLabelText('Лифт')).toHaveProperty('value', '');
  expect(screen.getByText(/фильтры.*предыдущ.*категории/i)).toBeTruthy();
  fireEvent.submit(view.container.querySelector('form')!);
  expect(routedDefinition().definition.attributes).toEqual({
    rooms: { min: 2, max: 4 },
  });
  expect(routedDefinition().definition.category).toBe('house');
});
test('a saved enum value omitted by the lookup remains visible and survives until deliberately cleared', async () => {
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('/categories/')
          ? [
              {
                code: 'finish',
                name: 'Отделка',
                kind: 'enum',
                options: ['modern'],
              },
            ]
          : {
              items: [],
              total: 0,
              totalIsEstimate: false,
              cursor: null,
              facets: {},
            },
    })),
  );
  const view = render(
    <SearchProduct
      initialDefinition={{
        category: 'apartment',
        attributes: { finish: 'legacy' },
      }}
    />,
  );
  await screen.findByLabelText('Отделка');
  expect(screen.getByLabelText('Отделка')).toHaveProperty('value', 'legacy');
  expect(screen.getByText(/legacy.*сохранённое значение/)).toBeTruthy();
  fireEvent.submit(view.container.querySelector('form')!);
  expect(routedDefinition().definition.attributes).toEqual({
    finish: 'legacy',
  });
  fireEvent.change(screen.getByLabelText('Отделка'), { target: { value: '' } });
  fireEvent.submit(view.container.querySelector('form')!);
  expect(routedDefinition().definition.attributes).toEqual({});
});
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
    await submitReadySearch();
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
  await submitReadySearch();
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
  await submitReadySearch();
  current = routedDefinition();
  expect(current.definition.attributes).toEqual({});
});
test('a late previous-search response cannot replace the new route or finish its loading', async () => {
  const replies: ((value: unknown) => void)[] = [];
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: () =>
        url === '/api/v1/regions' || url === '/api/v1/search/region-counts'
          ? Promise.resolve({ items: [] })
          : url.includes('/categories/')
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
    expect(
      screen
        .getAllByRole('status')
        .some((status) => status.textContent?.includes('Загрузка')),
    ).toBe(true),
  );
  expect(screen.queryByText(/999/)).toBeNull();
  replies[1]!({ items: [], total: 7, facets: {} });
  expect(await screen.findByText('Найдено около 7 объявлений')).toBeTruthy();
});
test('loading → empty results and accessible filters', async () => {
  stubFetch(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('/categories/')
          ? []
          : { items: [], total: 0, cursor: null, facets: {} },
    })),
  );
  render(<SearchProduct />);
  expect(
    screen
      .getAllByRole('status')
      .some((status) => status.textContent?.includes('Загрузка')),
  ).toBe(true);
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
  const fetch = vi.fn(async (url: string) =>
    url === '/api/v1/regions'
      ? { ok: true, json: async () => ({ items: [] }) }
      : url.includes('/categories/')
        ? { ok: true, json: async () => [] }
        : { ok: false, status: 503 },
  );
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

test('regional options distinguish zero published listings from missing counts', async () => {
  stubFetch('fetch', async (url) => ({
    ok: true,
    json: async () =>
      url === '/api/v1/regions'
        ? {
            items: [
              { code: 'moscow', name: 'Москва' },
              { code: 'omsk', name: 'Омская область' },
              { code: 'tomsk', name: 'Томская область' },
            ],
          }
        : url === '/api/v1/search/region-counts'
          ? {
              items: [
                { code: 'moscow', count: 19 },
                { code: 'omsk', count: 0 },
              ],
            }
          : { items: [], total: 0, cursor: null, facets: {} },
  }));
  render(<SearchProduct />);
  expect(
    await screen.findByRole('option', { name: 'Москва (19)' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('option', { name: 'Омская область (0)' }),
  ).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Томская область' })).toBeTruthy();
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
  stubFetch('fetch', fetch);
  const view = render(
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
  await vi.waitFor(() => expect(replace).toHaveBeenCalled());
  let routed = routedDefinition();
  window.history.replaceState({}, '', routed.url);
  view.rerender(<SearchProduct initialDefinition={routed.definition} />);
  await vi.waitFor(() =>
    expect((screen.getByLabelText('Город') as HTMLInputElement).value).toBe(''),
  );
  const navigations = replace.mock.calls.length;
  await submitReadySearch();
  await vi.waitFor(() =>
    expect(replace.mock.calls.length).toBeGreaterThan(navigations),
  );
  routed = routedDefinition();
  window.history.replaceState({}, '', routed.url);
  view.rerender(<SearchProduct initialDefinition={routed.definition} />);
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
  stubFetch(
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

test('empty short rental results clear only the stay dates', async () => {
  captureSearch();
  render(
    <SearchProduct
      initialDefinition={{
        dealType: 'short_rent',
        district: 'Арбат',
        attributes: {
          guest_capacity: { min: 3 },
          rental_available_from: { max: 20261230 },
          rental_available_until: { min: 20270102 },
          rental_minimum_nights: { max: 3 },
        },
      }}
      initialMode="map"
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Искать без дат' }),
  );
  const { url, definition } = routedDefinition();
  expect(url.searchParams.get('mode')).toBe('map');
  expect(definition).toMatchObject({
    dealType: 'short_rent',
    district: 'Арбат',
  });
  expect(definition.attributes).toEqual({ guest_capacity: { min: 3 } });
});

test('opens login for a guest saving the applied definition and keeps the current price draft on cancel', async () => {
  const submitted: unknown[] = [];
  stubFetch('fetch', async (url, init) => {
    if (url === '/api/v1/account/saved-searches') {
      submitted.push(JSON.parse(String(init?.body)));
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () =>
        url.includes('/attributes') ? [] : { items: [], total: 0 },
    };
  });
  const definition = { dealType: 'sale', price: { max: 4000000 } } as const;
  render(<SearchProduct initialDefinition={definition} />);
  const trigger = screen.getByRole('button', { name: 'Сохранить поиск' });
  await vi.waitFor(() => expect(trigger).toHaveProperty('disabled', false));
  const price = screen.getByLabelText<HTMLInputElement>('Цена до', {
    exact: true,
  });
  fireEvent.change(price, { target: { value: '5700000' } });
  fireEvent.click(trigger);
  await screen.findByRole('dialog', { name: 'Войдите, чтобы сохранить поиск' });
  expect(submitted).toEqual([{ name: 'Мой поиск', definition }]);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  await vi.waitFor(() =>
    expect(history.state?.rauiAccountAction).toBeUndefined(),
  );
  expect(price.value).toBe('5700000');
  expect(document.activeElement).toBe(trigger);
});
