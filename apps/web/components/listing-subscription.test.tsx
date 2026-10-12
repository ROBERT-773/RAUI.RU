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
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Сохранить подписку' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подписку' }));
  await screen.findByText(/Настройки подписки сохранены/);
  expect(api).toHaveBeenCalledWith(
    'v1/account/listing-subscriptions/fixture-listing',
    'POST',
    {
      events: ['price_drop', 'availability'],
      channels: ['email'],
      frequency: 'immediate',
      version: 1,
      consent: true,
    },
  );
});
test('missing consent prevents a preference write even on direct form submission', async () => {
  vi.mocked(api).mockResolvedValue({ version: 0 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Сохранить подписку' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.submit(
    screen.getByRole('button', { name: 'Сохранить подписку' }).closest('form')!,
  );
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith(
    'v1/account/listing-subscriptions/fixture-listing',
  );
});
