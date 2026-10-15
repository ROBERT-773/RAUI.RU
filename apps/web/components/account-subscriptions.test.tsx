import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AccountSubscriptions from './account-subscriptions';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const row = {
  listing_id: 'listing-a',
  events: ['price_drop'],
  channels: ['email'],
  frequency: 'daily',
  version: 3,
};
test('account disables only selected subscription using its current version', async () => {
  vi.mocked(api).mockImplementation(async (_path, method) =>
    method === 'POST' ? { ok: true } : [row],
  );
  render(<AccountSubscriptions />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Отключить подписку' }),
  );
  await screen.findByText(/Подписок пока нет/);
  expect(api).toHaveBeenCalledWith(
    'v1/account/listing-subscriptions/listing-a/disable',
    'POST',
    { version: 3 },
  );
});
test('failed disable preserves subscription and displays error without false success', async () => {
  vi.mocked(api).mockImplementation(async (_path, method) => {
    if (method === 'POST') throw new Error('Настройки изменены в другом окне');
    return [row];
  });
  render(<AccountSubscriptions />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Отключить подписку' }),
  );
  await screen.findByRole('alert');
  expect(screen.getByRole('link', { name: 'Открыть объявление' })).toBeTruthy();
});
test('account subscription settings disclose available in-app and unavailable email daily delivery', async () => {
  vi.mocked(api).mockResolvedValue([row]);
  render(<AccountSubscriptions />);
  await screen.findByRole('button', { name: 'Отключить подписку' });
  expect(
    screen.getByText(/Ежедневная подборка доступна в аккаунте/),
  ).toBeTruthy();
});

test('daily email remains explicitly unavailable', async () => {
  vi.mocked(api).mockResolvedValue([]);
  render(<AccountSubscriptions />);
  await screen.findByText(/Подписок пока нет/);
  expect(
    screen.getByText(/Ежедневная подборка по email пока недоступна/),
  ).toBeTruthy();
});

test('daily email-only subscription is shown unavailable rather than claiming account delivery', async () => {
  vi.mocked(api).mockResolvedValue([row]);
  render(<AccountSubscriptions />);
  expect(
    await screen.findByText(/ежедневная подборка по email — пока недоступна/),
  ).toBeTruthy();
});
