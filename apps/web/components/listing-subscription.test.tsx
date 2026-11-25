import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingSubscription from './listing-subscription';
import { api, ApiError } from '../lib/client';
vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test('a stale form reloads the saved preferences and requires fresh consent before resuming', async () => {
  const original = {
    version: 1,
    enabled: true,
    events: ['availability'],
    channels: ['email'],
    frequency: 'immediate',
  };
  vi.mocked(api)
    .mockResolvedValueOnce(original)
    .mockRejectedValueOnce(new ApiError('Conflict', 409))
    .mockResolvedValueOnce({ ...original, version: 2, enabled: false })
    .mockResolvedValueOnce({ version: 3 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  const consent = /Согласен получать выбранные/;
  fireEvent.click(await screen.findByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подписку' }));
  await screen.findByText(/Подписка изменилась в другой вкладке/);
  expect(
    screen.queryByRole('button', { name: 'Сохранить подписку' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Обновить настройки' }));
  await screen.findByText(/Подписка отключена/);
  expect((screen.getByLabelText(consent) as HTMLInputElement).checked).toBe(
    false,
  );
  expect(
    (screen.getByLabelText('Снижение цены') as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (screen.getByLabelText('На подтверждённый email') as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подписку' }));
  await screen.findByText(/Настройки подписки сохранены/);
  expect(api).toHaveBeenLastCalledWith(
    'v1/account/listing-subscriptions/fixture-listing',
    'POST',
    {
      events: ['availability'],
      channels: ['email'],
      frequency: 'immediate',
      version: 2,
      consent: true,
    },
  );
});
test('subscription saves explicit preferences without marketing consent', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ version: 0 })
    .mockResolvedValueOnce({ version: 1 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  fireEvent.click(
    await screen.findByLabelText(
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
      version: 0,
    },
  );
});
test('missing consent prevents saving even on direct form submission', async () => {
  vi.mocked(api).mockResolvedValue({ version: 0 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  fireEvent.submit(
    (await screen.findByRole('button', { name: 'Сохранить подписку' })).closest(
      'form',
    )!,
  );
  expect(api).toHaveBeenCalledTimes(1);
});
test('subscription form distinguishes daily in-app release from unavailable daily email', async () => {
  vi.mocked(api).mockResolvedValue({ version: 0 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  expect(
    await screen.findByText(/Ежедневная подборка доступна в аккаунте/),
  ).toBeTruthy();
});

test('daily email remains explicitly unavailable', async () => {
  vi.mocked(api).mockResolvedValue({ version: 0 });
  render(<ListingSubscription id="fixture-listing" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Подписаться на изменения' }),
  );
  expect(
    await screen.findByText(/Ежедневная подборка по email пока недоступна/),
  ).toBeTruthy();
});
