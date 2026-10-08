import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import OwnerListings from './owner-listings';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
vi.mock('./new-listing', () => ({ default: () => <p>Создание объекта</p> }));
const listing = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Квартира у парка',
  price: '9000000',
  description: 'Реальная квартира',
  terms: { deposit: 100 },
  status: 'draft',
  version: 3,
  deal_type: 'sale',
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(status = 'draft') {
  vi.mocked(api).mockImplementation(async (path, method, body) => {
    if (path === 'v1/auth/me')
      return {
        role: 'owner',
        email_verified_at: 'now',
        phone_verified_at: 'now',
      };
    if (path === 'v1/listings?limit=20') return [{ ...listing, status }];
    if (path.endsWith('/history'))
      return [
        {
          action: 'moderation.decided',
          after: { reason: 'Уточните описание' },
        },
      ];
    if (path.startsWith('v1/media/listing/'))
      return [{ id: 'photo', state: 'ready', kind: 'photo' }];
    if (method === 'PATCH')
      return { ...listing, ...(body as object), version: 4 };
    if (path.endsWith('/transitions'))
      return { ...listing, ...(body as object), version: 4 };
    return { ...listing, status };
  });
}
test('owner opens an existing draft and saves editable offer fields with its version', async () => {
  setup();
  render(<OwnerListings />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Квартира у парка' }),
  );
  fireEvent.change(await screen.findByLabelText('Цена, ₽'), {
    target: { value: '9100000' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await screen.findByText('Изменения сохранены.');
  expect(api).toHaveBeenCalledWith(`v1/listings/${listing.id}`, 'PATCH', {
    version: 3,
    title: listing.title,
    price: 9100000,
    description: listing.description,
  });
});
test('published offer must be paused before editing and then uses authoritative fresh data', async () => {
  setup('published');
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByRole('button', { name: 'Приостановить' });
  expect(
    screen.queryByRole('button', { name: 'Сохранить изменения' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Приостановить' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `v1/listings/${listing.id}/transitions`,
      'POST',
      { version: 3, status: 'paused' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    ),
  );
});
test('failed access exposes no draft controls', async () => {
  vi.mocked(api).mockRejectedValue(
    new Error('Войдите в аккаунт, чтобы продолжить.'),
  );
  render(<OwnerListings />);
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Цена, ₽')).toBeNull();
});
test('unverified phone does not expose creation or publication controls', async () => {
  setup();
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me'
      ? { role: 'owner', email_verified_at: 'now', phone_verified_at: null }
      : [],
  );
  render(<OwnerListings />);
  await screen.findByText(/Подтвердите email и телефон/);
  expect(screen.queryByText('Создание объекта')).toBeNull();
});

test('published offer links to the actual public route', async () => {
  setup('published');
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  expect(
    (
      await screen.findByRole('link', {
        name: 'Открыть опубликованное объявление',
      })
    ).getAttribute('href'),
  ).toBe(`/listings/${listing.id}`);
});
test('unsaved offer changes cannot be overwritten by media refresh or navigation', async () => {
  setup();
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.change(await screen.findByLabelText('Цена, ₽'), {
    target: { value: '9990000' },
  });
  expect(
    (
      screen.getByRole('button', {
        name: 'Обновить состояние',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText('Добавить фотографию') as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: listing.title }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Отменить несохранённые изменения' }),
  );
  expect((screen.getByLabelText('Цена, ₽') as HTMLInputElement).value).toBe(
    '9000000',
  );
});
test('submission advances processing then moderation with fresh versions and separate keys', async () => {
  setup();
  let status = 'draft',
    version = 3;
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === `v1/listings/${listing.id}`)
      return { ...listing, status, version };
    if (path.endsWith('/transitions')) {
      const input = body as { status: string; version: number };
      expect(input.version).toBe(version);
      status = input.status;
      return { ...listing, status, version: ++version };
    }
    return base(path, method, body, options);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Отправить на модерацию' }),
  );
  await screen.findByText(/Объявление отправлено на модерацию/);
  const requests = vi
    .mocked(api)
    .mock.calls.filter((call) => call[0].endsWith('/transitions'));
  expect(requests.map((call) => call[2])).toEqual([
    { version: 3, status: 'processing' },
    { version: 4, status: 'moderation' },
  ]);
  expect(requests[0]?.[3]?.idempotencyKey).not.toBe(
    requests[1]?.[3]?.idempotencyKey,
  );
  expect(
    screen.queryByRole('button', { name: 'Отправить на модерацию' }),
  ).toBeNull();
});
test('failed or pending photographs prevent submission', async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) =>
    path.startsWith('v1/media/listing/')
      ? [{ id: 'bad', state: 'failed', kind: 'photo' }]
      : base(path, method, body, options),
  );
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByText('Ошибка обработки фотографии');
  expect(
    (
      screen.getByRole('button', {
        name: 'Отправить на модерацию',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test('uncertain photo upload retains an identical request key on retry', async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  let failed = false;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === 'v1/media' && method === 'POST') {
      if (!failed) {
        failed = true;
        throw new Error('Connection lost');
      }
      return { id: 'photo', state: 'pending' };
    }
    return base(path, method, body, options);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.change(await screen.findByLabelText('Добавить фотографию'), {
    target: {
      files: [
        new File(['synthetic-image'], 'object.png', { type: 'image/png' }),
      ],
    },
  });
  await screen.findByText('Connection lost');
  fireEvent.click(
    screen.getByRole('button', { name: 'Повторить загрузку фотографии' }),
  );
  await screen.findByText('Фотография загружена и ожидает обработки.');
  const calls = vi
    .mocked(api)
    .mock.calls.filter((call) => call[0] === 'v1/media');
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2]);
  expect(calls[0]?.[3]).toEqual(calls[1]?.[3]);
  expect(
    screen.queryByRole('button', { name: 'Повторить загрузку фотографии' }),
  ).toBeNull();
});

test.each([
  new File(['bytes'], 'x'.repeat(201) + '.png', { type: 'image/png' }),
  new File(['bytes'], 'wrong.png', { type: 'image/jpeg' }),
])(
  'invalid image name or MIME leaves the file chooser usable',
  async (file) => {
    setup();
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    fireEvent.change(await screen.findByLabelText('Добавить фотографию'), {
      target: { files: [file] },
    });
    await screen.findByRole('alert');
    expect(
      vi.mocked(api).mock.calls.filter((call) => call[0] === 'v1/media'),
    ).toHaveLength(0);
    expect(
      (screen.getByLabelText('Добавить фотографию') as HTMLInputElement)
        .disabled,
    ).toBe(false);
  },
);
