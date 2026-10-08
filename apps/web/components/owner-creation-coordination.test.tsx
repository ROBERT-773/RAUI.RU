import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import OwnerListings from './owner-listings';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test('creation locks the existing editor until the final listing request settles', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const listing = {
    id: 'existing',
    version: 1,
    status: 'draft',
    title: 'Существующее объявление',
    price: '5000000',
    description: '',
  };
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === 'v1/auth/me')
      return {
        role: 'owner',
        email_verified_at: 'now',
        phone_verified_at: 'now',
      };
    if (path === 'v1/listings?limit=20') return [listing];
    if (path === 'v1/listings/existing') return listing;
    if (path.startsWith('v1/media/listing/') || path.endsWith('/history'))
      return [];
    if (path === 'v1/categories')
      return [{ code: 'apartment', name: 'Квартира' }];
    if (path.endsWith('/attributes')) return [];
    if (path === 'v1/properties') return { id: 'property' };
    if (path === 'v1/listings' && method === 'POST') return pending;
    throw new Error(path);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const editor = await screen.findByRole('group', {
    name: 'Условия предложения',
  });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  for (const [name, value] of [
    ['Адрес', 'Москва, дом 1'],
    ['Населённый пункт', 'Москва'],
    ['Долгота', '37.6'],
    ['Широта', '55.7'],
    ['Заголовок', 'Новое объявление'],
  ] as const)
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  const creation = screen
    .getByRole('heading', { name: 'Новое объявление' })
    .closest('form')!;
  fireEvent.change(within(creation).getByLabelText('Цена, ₽'), {
    target: { value: '10000000' },
  });
  await vi.waitFor(() =>
    expect(
      (
        within(creation).getByRole('button', {
          name: 'Сохранить черновик',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(creation).getByRole('button', { name: 'Сохранить черновик' }),
  );
  await vi.waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      'v1/listings',
      'POST',
      expect.any(Object),
      expect.any(Object),
    ),
  );
  expect(
    (within(editor).getByLabelText('Цена, ₽') as HTMLInputElement).matches(
      ':disabled',
    ),
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: listing.title }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  finish({ id: 'new' });
});
