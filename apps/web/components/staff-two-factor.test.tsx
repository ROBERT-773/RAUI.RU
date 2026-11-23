import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../lib/client';
import StaffTwoFactor from './staff-two-factor';

vi.mock('../lib/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/client')>()),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test('enrolls and verifies before mounting the protected workbench', async () => {
  const pending = {
    enrolled: false,
    available: true,
    required: true,
    assuredUntil: null,
  };
  vi.mocked(api)
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce({ secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({
      ...pending,
      enrolled: true,
      assuredUntil: new Date(Date.now() + 60000).toISOString(),
    });
  render(
    <StaffTwoFactor>
      <p>Очередь проверки</p>
    </StaffTwoFactor>,
  );
  const password = await screen.findByLabelText('Пароль аккаунта');
  expect(screen.queryByText('Очередь проверки')).toBeNull();
  fireEvent.change(password, { target: { value: 'test-only-password' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Настроить второй фактор' }),
  );
  const code = await screen.findByLabelText('Код из приложения');
  expect(screen.queryByText('Очередь проверки')).toBeNull();
  fireEvent.change(code, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить вход' }));
  await screen.findByText('Очередь проверки');
  expect(api).toHaveBeenCalledWith('v1/auth/staff-totp/enroll', 'POST', {
    password: 'test-only-password',
  });
  expect(api).toHaveBeenCalledWith('v1/auth/staff-totp/activate', 'POST', {
    code: '123456',
  });
  expect(screen.queryByText('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBeNull();
});

test('requires a new code when a previously verified session has expired', async () => {
  vi.mocked(api).mockResolvedValueOnce({
    enrolled: true,
    available: true,
    required: true,
    assuredUntil: new Date(Date.now() - 1000).toISOString(),
  });
  render(
    <StaffTwoFactor>
      <p>Очередь проверки</p>
    </StaffTwoFactor>,
  );
  await screen.findByLabelText('Код из приложения');
  expect(screen.queryByText('Очередь проверки')).toBeNull();
  expect(screen.queryByLabelText('Пароль аккаунта')).toBeNull();
});
