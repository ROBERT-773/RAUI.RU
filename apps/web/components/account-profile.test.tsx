import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from '@testing-library/react';
import AccountProfile from './account-profile';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
const user = {
  email: 'owner@example.test',
  phone: null,
  role: 'owner',
  email_verified_at: null,
  phone_verified_at: null,
  registration_approval_state: 'pending',
  registration_approval_reason: null,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test('shows persisted contact and independent pending approval states', async () => {
  vi.mocked(api).mockResolvedValue(user);
  render(<AccountProfile />);
  await screen.findByText('Ожидает одобрения сотрудника');
  expect(screen.getByText('owner@example.test')).toBeTruthy();
  expect(screen.getAllByText('Не подтверждён').length).toBe(2);
});
test('provider failure leaves request controls usable without claiming delivery', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === 'v1/auth/me') return user;
    throw new Error('Подтверждение недоступно');
  });
  render(<AccountProfile />);
  await screen.findByText('owner@example.test');
  fireEvent.click(
    screen.getByRole('button', { name: 'Запросить подтверждение email' }),
  );
  await screen.findByRole('alert');
  expect(
    (
      screen.getByRole('button', {
        name: 'Запросить подтверждение email',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
test('phone confirmation refreshes persisted state before notifying parent', async () => {
  let reads = 0;
  const refresh = vi.fn();
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me'
      ? ++reads === 1
        ? user
        : { ...user, phone: '+79991234567', phone_verified_at: 'now' }
      : { ok: true },
  );
  render(<AccountProfile onRefresh={refresh} />);
  await screen.findByText('owner@example.test');
  fireEvent.change(
    screen.getByLabelText('Код подтверждения телефона из сообщения'),
    { target: { value: 'a'.repeat(43) } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить телефон' }));
  await screen.findByText('+79991234567');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith(
    'v1/auth/verification/phone/confirm',
    'POST',
    { token: 'a'.repeat(43) },
  );
});
test('unmounted confirmation cannot refresh parent or start another profile request', async () => {
  let finish!: (value: unknown) => void;
  const refresh = vi.fn();
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me'
      ? user
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const view = render(<AccountProfile onRefresh={refresh} />);
  await screen.findByText('owner@example.test');
  fireEvent.change(
    screen.getByLabelText('Код подтверждения телефона из сообщения'),
    { target: { value: 'a'.repeat(43) } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить телефон' }));
  view.unmount();
  await act(async () => finish({ ok: true }));
  expect(refresh).not.toHaveBeenCalled();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/auth/me'),
  ).toHaveLength(1);
});
test('busy action prevents duplicate requests and reports acceptance only', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me'
      ? user
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  render(<AccountProfile />);
  await screen.findByText('owner@example.test');
  const button = screen.getByRole('button', {
    name: 'Запросить подтверждение email',
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/email')),
  ).toHaveLength(1);
  await act(async () => finish({ accepted: true }));
  await screen.findByText(/Запрос принят/);
});
test('rejected profile displays its own reason', async () => {
  vi.mocked(api).mockResolvedValue({
    ...user,
    registration_approval_state: 'rejected',
    registration_approval_reason: 'Проверьте данные',
  });
  render(<AccountProfile />);
  await screen.findByText('Проверьте данные');
  expect(screen.getByText('Регистрация отклонена')).toBeTruthy();
});
test('failed persisted refresh does not tell parent that confirmation state changed', async () => {
  let reads = 0;
  const refresh = vi.fn();
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === 'v1/auth/me') {
      if (++reads > 1) throw new Error('Обновление недоступно');
      return user;
    }
    return { ok: true };
  });
  render(<AccountProfile onRefresh={refresh} />);
  await screen.findByText('owner@example.test');
  fireEvent.change(
    screen.getByLabelText('Код подтверждения email из сообщения'),
    { target: { value: 'b'.repeat(43) } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить email' }));
  await screen.findByText('Обновление недоступно');
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getAllByText('Не подтверждён')).toHaveLength(2);
});
test('requests verification for the exact E164 phone and does not mark it verified', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me' ? user : { accepted: true },
  );
  render(<AccountProfile />);
  await screen.findByText('owner@example.test');
  fireEvent.change(screen.getByLabelText('Номер телефона'), {
    target: { value: '+79991234567' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Запросить подтверждение телефона' }),
  );
  await screen.findByText(/Запрос принят/);
  expect(api).toHaveBeenCalledWith('v1/auth/verification/phone', 'POST', {
    phone: '+79991234567',
  });
  expect(screen.getAllByText('Не подтверждён')).toHaveLength(2);
});
test('expired session during profile refresh notifies the parent', async () => {
  const expired = vi.fn();
  let reads = 0;
  vi.mocked(api).mockImplementation(async () => {
    if (++reads === 1) return user;
    throw Object.assign(new Error('Войдите'), { status: 401 });
  });
  render(<AccountProfile onSessionExpired={expired} />);
  await screen.findByText('owner@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Обновить профиль' }));
  await screen.findByRole('alert');
  expect(expired).toHaveBeenCalledTimes(1);
});
test('expired session on initial load notifies but late unmounted failure does not', async () => {
  const expired = vi.fn();
  vi.mocked(api).mockRejectedValue(
    Object.assign(new Error('Войдите'), { status: 401 }),
  );
  const first = render(<AccountProfile onSessionExpired={expired} />);
  await screen.findByRole('alert');
  expect(expired).toHaveBeenCalledTimes(1);
  first.unmount();
  expired.mockClear();
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const second = render(<AccountProfile onSessionExpired={expired} />);
  second.unmount();
  await act(async () =>
    reject(Object.assign(new Error('Войдите'), { status: 401 })),
  );
  expect(expired).not.toHaveBeenCalled();
});
test('provider unavailability never expires the current session', async () => {
  const expired = vi.fn();
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === 'v1/auth/me') return user;
    throw Object.assign(new Error('Недоступно'), { status: 503 });
  });
  render(<AccountProfile onSessionExpired={expired} />);
  await screen.findByText('owner@example.test');
  fireEvent.click(
    screen.getByRole('button', { name: 'Запросить подтверждение email' }),
  );
  await screen.findByRole('alert');
  expect(expired).not.toHaveBeenCalled();
  expect(screen.getByText('owner@example.test')).toBeTruthy();
});
test('accepted email token does not claim this profile is verified when refreshed contact is unverified', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me' ? user : { ok: true },
  );
  render(<AccountProfile />);
  await screen.findByText('owner@example.test');
  fireEvent.change(
    screen.getByLabelText('Код подтверждения email из сообщения'),
    { target: { value: 'c'.repeat(43) } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить email' }));
  await screen.findByText(
    'Запрос обработан. Проверьте статус контакта в профиле.',
  );
  expect(screen.queryByText('Контакт подтверждён.')).toBeNull();
  expect(screen.getAllByText('Не подтверждён')).toHaveLength(2);
});
