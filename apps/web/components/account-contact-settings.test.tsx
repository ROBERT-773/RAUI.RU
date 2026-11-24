import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { api, ApiError, ContactPhoneRequiredError } from '../lib/client';
import AccountContactSettings from './account-contact-settings';

vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
const base = {
  mode: 'messages',
  phones: [{ id: 'p1', phone: '+79990000001', primary: true }],
};
const added = { id: 'p2', phone: '+79990000002', primary: false };

test('verifies a separate number before showing it in the profile and can remove only the addition', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce(base)
    .mockResolvedValueOnce({
      delivery: 'accepted',
      resendAfter: new Date(0).toISOString(),
    })
    .mockResolvedValueOnce({ ...base, phones: [...base.phones, added] })
    .mockResolvedValueOnce(base);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<AccountContactSettings onSessionExpired={vi.fn()} />);
  await screen.findByText(/Основной номер/);
  expect(screen.queryByRole('button', { name: /Удалить/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Дополнительный номер'), {
    target: { value: '8 (999) 000-00-02' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Получить код для номера' }),
  );
  const code = await screen.findByLabelText('Код для дополнительного номера');
  expect(vi.mocked(api).mock.calls[1]).toEqual([
    'v1/account/contact-phones/request',
    'POST',
    { phone: added.phone },
  ]);
  expect(screen.queryByRole('button', { name: /Удалить/ })).toBeNull();
  fireEvent.change(code, { target: { value: '312810' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Подтвердить дополнительный номер' }),
  );
  const remove = await screen.findByRole('button', {
    name: 'Удалить дополнительный номер ' + added.phone,
  });
  expect(vi.mocked(api).mock.calls[2]).toEqual([
    'v1/account/contact-phones/verify',
    'POST',
    { phone: added.phone, code: '312810' },
  ]);
  fireEvent.click(remove);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Удалить/ })).toBeNull(),
  );
  expect(vi.mocked(api).mock.calls[3]).toEqual([
    'v1/account/contact-phones/p2',
    'DELETE',
  ]);
  expect(screen.getByText(/Основной номер/)).toBeTruthy();
});

test('shows affected listings after a calls-only conflict and keeps the saved mode until success', async () => {
  const id = '34595315-8b69-4130-afaa-fe6f68672366';
  vi.mocked(api)
    .mockResolvedValueOnce(base)
    .mockRejectedValueOnce(
      new ContactPhoneRequiredError([{ id, title: 'Продажа квартиры' }], 1),
    )
    .mockResolvedValueOnce({ ...base, mode: 'both' });
  render(<AccountContactSettings onSessionExpired={vi.fn()} />);
  const selector = await screen.findByRole<HTMLSelectElement>('combobox', {
    name: 'Способ связи для всех объявлений',
  });
  fireEvent.change(selector, { target: { value: 'calls' } });
  const link = await screen.findByRole('link', { name: 'Продажа квартиры' });
  expect(link.getAttribute('href')).toBe('/account/listings?listing=' + id);
  expect(selector.value).toBe('messages');
  fireEvent.change(selector, { target: { value: 'both' } });
  await waitFor(() => expect(selector.value).toBe('both'));
  expect(api).toHaveBeenLastCalledWith('v1/account/contact-settings', 'PATCH', {
    mode: 'both',
  });
});

test('retry loads actual settings; a failed SMS request never adds an unverified phone', async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error('Связь прервана'))
    .mockResolvedValueOnce(base)
    .mockRejectedValueOnce(
      new ApiError('Сейчас отправка SMS недоступна.', 503),
    );
  render(<AccountContactSettings onSessionExpired={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Обновить настройки связи' }),
  );
  fireEvent.change(await screen.findByLabelText('Дополнительный номер'), {
    target: { value: added.phone },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Получить код для номера' }),
  );
  await screen.findByText('Сейчас отправка SMS недоступна.');
  expect(screen.queryByLabelText('Код для дополнительного номера')).toBeNull();
});
