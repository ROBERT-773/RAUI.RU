import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import NewListing from './new-listing';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(fail = false) {
  let failed = false;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === 'v1/categories')
      return [
        { code: 'apartment', name: 'Квартира' },
        { code: 'land', name: 'Участок' },
      ];
    if (path.endsWith('/attributes'))
      return [
        {
          code: 'area',
          name: 'Площадь',
          kind: 'number',
          required: true,
          options: [],
        },
      ];
    if (path === 'v1/properties' && method === 'POST')
      return { id: 'property-1' };
    if (path === 'v1/listings' && method === 'POST') {
      if (fail && !failed) {
        failed = true;
        throw new Error('Недоступно');
      }
      return { id: 'listing-1' };
    }
    throw new Error(path);
  });
}
async function fill() {
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  await screen.findByLabelText('Площадь *');
  for (const [label, value] of [
    ['Адрес', 'Москва, улица 1'],
    ['Населённый пункт', 'Москва'],
    ['Долгота', '0'],
    ['Широта', '0'],
    ['Площадь *', '40'],
    ['Заголовок', 'Квартира рядом с парком'],
    ['Цена, ₽', '5000000'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
test('creates a draft with explicit region and zero coordinates', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/properties',
    'POST',
    expect.objectContaining({
      address: expect.objectContaining({
        regionCode: 'moscow',
        longitude: 0,
        latitude: 0,
      }),
      attributes: { area: 40 },
    }),
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
});
test('retains created property and retries identical listing request without duplicate property', async () => {
  setup(true);
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await screen.findByRole('alert');
  expect(
    (screen.getByLabelText('Заголовок') as HTMLInputElement).closest('fieldset')
      ?.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить сохранение' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  const calls = vi.mocked(api).mock.calls;
  expect(calls.filter(([path]) => path === 'v1/properties')).toHaveLength(1);
  const listingCalls = calls.filter(([path]) => path === 'v1/listings');
  expect(listingCalls[0]).toEqual(listingCalls[1]);
});
test('changing category clears category-specific values', async () => {
  setup();
  render(<NewListing onCreated={() => {}} />);
  await fill();
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'land' },
  });
  await waitFor(() =>
    expect((screen.getByLabelText('Площадь *') as HTMLInputElement).value).toBe(
      '',
    ),
  );
});

test('ignores late definitions from a previous category', async () => {
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === 'v1/categories')
      return [
        { code: 'apartment', name: 'Квартира' },
        { code: 'land', name: 'Участок' },
      ];
    if (path === 'v1/categories/apartment/attributes')
      return new Promise((resolve) => {
        release = resolve;
      });
    return [
      {
        code: 'area',
        name: 'Площадь участка',
        kind: 'number',
        required: true,
        options: [],
      },
    ];
  });
  render(<NewListing onCreated={() => {}} />);
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'land' },
  });
  await screen.findByLabelText('Площадь участка *');
  release?.([
    {
      code: 'rooms',
      name: 'Комнаты квартиры',
      kind: 'number',
      required: true,
      options: [],
    },
  ]);
  await waitFor(() =>
    expect(screen.queryByLabelText('Комнаты квартиры *')).toBeNull(),
  );
  expect(screen.getByLabelText('Площадь участка *')).toBeTruthy();
});

test('completed creation cannot resubmit and explicit reset creates a new attempt', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await screen.findByRole('status');
  fireEvent.submit(screen.getByLabelText('Заголовок').closest('form')!);
  expect(created).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Создать ещё объявление' }),
  );
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(created).toHaveBeenCalledTimes(2));
  const properties = vi
    .mocked(api)
    .mock.calls.filter(([path]) => path === 'v1/properties');
  expect(properties).toHaveLength(2);
  expect(properties[0]?.[3]).not.toEqual(properties[1]?.[3]);
});
test('parent disabled state prevents new requests', async () => {
  setup();
  render(<NewListing disabled onCreated={() => {}} />);
  await screen.findByRole('option', { name: 'Квартира' });
  expect(
    (screen.getByLabelText('Категория') as HTMLSelectElement).closest(
      'fieldset',
    )?.disabled,
  ).toBe(true);
});
test('unmount during property creation does not create a listing or notify parent', async () => {
  setup();
  const created = vi.fn();
  const view = render(<NewListing onCreated={created} />);
  await fill();
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  view.unmount();
  await act(async () => {
    release?.({ id: 'property-1' });
  });
  expect(created).not.toHaveBeenCalled();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/listings'),
  ).toHaveLength(0);
});

test('parent disabling while property request is pending pauses before listing creation', async () => {
  setup();
  const created = vi.fn();
  const view = render(<NewListing onCreated={created} />);
  await fill();
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/properties'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : { id: 'listing-1' },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  view.rerender(<NewListing disabled onCreated={created} />);
  await act(async () => {
    release?.({ id: 'property-1' });
  });
  expect(created).not.toHaveBeenCalled();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/listings'),
  ).toHaveLength(0);
  view.rerender(<NewListing onCreated={created} />);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить сохранение' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
});

test('reports busy until the final listing request settles', async () => {
  setup();
  const created = vi.fn();
  const busy = vi.fn();
  render(<NewListing onCreated={created} onBusyChange={busy} />);
  await fill();
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/properties'
      ? { id: 'property-1' }
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(release).toBeDefined());
  expect(busy.mock.calls).toEqual([[true]]);
  await act(async () => {
    release?.({ id: 'listing-1' });
  });
  expect(created).toHaveBeenCalledWith('listing-1');
  expect(busy.mock.calls).toEqual([[true], [false]]);
});
