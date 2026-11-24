import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import OwnerListings from './owner-listings';
import { api } from '../lib/client';
vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test.each([
  { failFirstRead: false, failListRefresh: true },
  { failFirstRead: true, failListRefresh: true },
  { failFirstRead: false, failListRefresh: false },
])(
  'creation keeps the saved draft in the list, first read fails: $failFirstRead, list refresh fails: $failListRefresh',
  async ({ failFirstRead, failListRefresh }) => {
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
    const newListing = { ...listing, id: 'new', title: 'Новый черновик' };
    let listRequests = 0;
    let draftReads = 0;
    vi.mocked(api).mockImplementation(async (path, method) => {
      if (path === 'v1/auth/me')
        return {
          role: 'owner',
          email_verified_at: 'now',
          phone_verified_at: 'now',
        };
      if (path === 'v1/listings?limit=20') {
        if (++listRequests > 1 && failListRefresh)
          throw new Error('Список временно недоступен');
        return [listing];
      }
      if (path === 'v1/listings/existing') return listing;
      if (path === 'v1/listings/new') {
        if (++draftReads === 1 && failFirstRead) throw new Error('Read failed');
        return newListing;
      }
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
    const next = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await vi.waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    next();
    for (const [name, value] of [
      ['Адрес', 'Москва, дом 1'],
      ['Населённый пункт', 'Москва'],
      ['Долгота', '37.6'],
      ['Широта', '55.7'],
    ] as const)
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    next();
    next();
    fireEvent.change(screen.getByLabelText('Заголовок'), {
      target: { value: 'Новое объявление' },
    });
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
            name: 'Перейти к фотографиям',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      within(creation).getByRole('button', { name: 'Перейти к фотографиям' }),
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
    if (failFirstRead) {
      const retry = await screen.findByRole<HTMLButtonElement>('button', {
        name: 'Открыть сохранённый черновик',
      });
      await waitFor(() => expect(retry.disabled).toBe(false));
      fireEvent.click(retry);
    }
    const heading = await screen.findByRole('heading', {
      name: newListing.title,
      level: 2,
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const saved = await screen.findByRole<HTMLButtonElement>('button', {
      name: newListing.title,
    });
    await waitFor(() => expect(saved.disabled).toBe(false));
    expect(screen.getByRole('button', { name: newListing.title })).toBe(saved);
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          ([path, method]) => path === 'v1/listings' && method === 'POST',
        ),
    ).toHaveLength(1);
  },
);
