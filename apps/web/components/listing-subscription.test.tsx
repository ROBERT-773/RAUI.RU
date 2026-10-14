import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingSubscription from './listing-subscription';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test('subscription saves explicit preferences without marketing consent', async () => {
  vi.mocked(api).mockResolvedValue({ version: 1 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  fireEvent.click(
    screen.getByLabelText(
      'Согласен получать выбранные уведомления об этом объявлении',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подписку' }));
  await screen.findByText(/Настройки подписки сохранены/);
  expect(api).toHaveBeenCalledWith(
    'v1/account/listing-subscriptions/fixture-listing',
    'POST',
    {
      events: ['price_drop', 'availability'],
      channels: ['in_app'],
      frequency: 'daily',
      consent: true,
    },
  );
});
test('missing consent prevents API request even on direct form submission', () => {
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  fireEvent.submit(
    screen.getByRole('button', { name: 'Сохранить подписку' }).closest('form')!,
  );
  expect(api).not.toHaveBeenCalled();
});
test('subscription form distinguishes daily in-app release from unavailable daily email', () => {
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  expect(
    screen.getByText(/Ежедневная подборка доступна в аккаунте/),
  ).toBeTruthy();
});

test('daily email remains explicitly unavailable', async () => {
  vi.mocked(api).mockResolvedValue([]);
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  expect(
    screen.getByText(/Ежедневная подборка по email пока недоступна/),
  ).toBeTruthy();
});
