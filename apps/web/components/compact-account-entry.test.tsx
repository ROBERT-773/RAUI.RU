import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../lib/client';
import Account from './account';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
const me = {
  id: 'test-user',
  public_id: '303',
  role: 'buyer',
  display_name: 'Анна',
};
const session = { user: me, csrfToken: 'test-session' };
const guest = () => vi.mocked(api).mockRejectedValueOnce(new Error('Гость'));
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));
const enter = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
const alternatives = () =>
  fireEvent.click(screen.getByText('Другой способ', { exact: true }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});

test('offers SMS first and keeps email or ID and the return to SMS accessible', async () => {
  guest();
  render(
    <Account
      compactEntry
      smsAvailable
      entryTitle="Войдите, чтобы разместить объявление"
    />,
  );
  expect(
    await screen.findByRole('heading', {
      name: 'Войдите, чтобы разместить объявление',
    }),
  ).toBeTruthy();
  expect(screen.getByLabelText('Телефон')).toBeTruthy();
  expect(screen.queryByLabelText('Email или ID')).toBeNull();
  expect(screen.queryByLabelText('Пароль')).toBeNull();
  click('Другой способ');
  expect(screen.getByLabelText('Email или ID')).toBeTruthy();
  alternatives();
  click('Войти по SMS');
  expect(screen.getByRole('button', { name: 'Получить код' })).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(1);
});

test.each([
  ['303', 'publicId', true],
  ['anna@example.test', 'email', false],
] as const)(
  'continues from %s to a password without sending a code',
  async (value, field, emailAvailable) => {
    guest().mockResolvedValueOnce(session);
    const authenticated = vi.fn();
    render(
      <Account
        compactEntry
        emailAvailable={emailAvailable}
        onAuthenticated={authenticated}
      />,
    );
    await screen.findByLabelText('Email или ID');
    expect(screen.queryByLabelText('Пароль')).toBeNull();
    expect(screen.queryByLabelText('Телефон')).toBeNull();
    enter('Email или ID', value);
    click('Продолжить');
    expect(
      screen.getByRole('heading', { name: 'Введите пароль' }),
    ).toBeTruthy();
    click('Назад');
    expect(screen.getByLabelText<HTMLInputElement>('Email или ID').value).toBe(
      value,
    );
    click('Продолжить');
    enter('Пароль', 'test-password');
    click('Войти');
    await waitFor(() =>
      expect(authenticated).toHaveBeenCalledExactlyOnceWith(me),
    );
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith('v1/auth/login', 'POST', {
      [field]: value,
      password: 'test-password',
      transport: 'cookie',
    });
  },
);

test('remembers a password choice made before typing an email address', async () => {
  guest();
  render(<Account compactEntry emailAvailable />);
  await screen.findByLabelText('Email или ID');
  alternatives();
  click('Войти с паролем');
  expect(screen.getByRole('heading', { name: 'Вход с паролем' })).toBeTruthy();
  enter('Email или ID', 'anna@example.test');
  click('Продолжить');
  expect(screen.getByLabelText('Пароль')).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(1);
});

test('one Continue sends an email code and preserves the chosen registration role', async () => {
  guest()
    .mockResolvedValueOnce({
      challengeId: 'challenge',
      resendAfter: new Date(Date.now() + 60000).toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    })
    .mockResolvedValueOnce(session);
  const authenticated = vi.fn();
  render(
    <Account compactEntry emailAvailable onAuthenticated={authenticated} />,
  );
  await screen.findByLabelText('Email или ID');
  enter('Email или ID', 'ANNA@example.test');
  alternatives();
  fireEvent.click(screen.getByText('Роль при регистрации'));
  enter('Кто вы?', 'owner');
  click('Продолжить');
  await screen.findByRole('dialog', { name: 'Подтверждение почты' });
  expect(api).toHaveBeenLastCalledWith(
    'v1/auth/email-sign-in',
    'POST',
    expect.objectContaining({ email: 'anna@example.test' }),
    { idempotencyKey: expect.any(String) },
  );
  await act(async () => enter('Код подтверждения', '123456'));
  expect(api).toHaveBeenLastCalledWith(
    'v1/auth/email-sign-in/confirm',
    'POST',
    expect.objectContaining({ registrationRole: 'owner' }),
  );
  expect(authenticated).toHaveBeenCalledExactlyOnceWith(me);
});

test('keeps password registration and recovery accessible with delivery disabled', async () => {
  guest().mockResolvedValueOnce({}).mockResolvedValueOnce(session);
  const authenticated = vi.fn();
  render(<Account compactEntry onAuthenticated={authenticated} />);
  await screen.findByLabelText('Email или ID');
  enter('Email или ID', 'garden');
  click('Продолжить');
  expect(screen.getByRole('alert').textContent).toMatch(/цифровой ID/);
  enter('Email или ID', 'anna@example.test');
  expect(screen.queryByText('Другой способ', { exact: true })).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Забыли пароль?' }).getAttribute('href'),
  ).toBe('/account/forgot-password');
  expect(screen.queryByText('Войти по SMS')).toBeNull();
  expect(screen.queryByText('Роль при регистрации')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Регистрация' }).closest('details'),
  ).toBeNull();
  click('Регистрация');
  expect(document.activeElement).toBe(screen.getByLabelText('Кто вы?'));
  expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe(
    'anna@example.test',
  );
  enter('Кто вы?', 'buyer');
  enter('Имя', 'Анна');
  enter('Пароль', 'test-password');
  click('Создать и войти');
  await waitFor(() =>
    expect(authenticated).toHaveBeenCalledExactlyOnceWith(me),
  );
  expect(api).toHaveBeenCalledWith('v1/auth/register', 'POST', {
    email: 'anna@example.test',
    displayName: 'Анна',
    password: 'test-password',
    role: 'buyer',
  });
});

test('notifies the owner immediately when an existing session is found', async () => {
  vi.mocked(api).mockResolvedValueOnce(me);
  const authenticated = vi.fn();
  const renderEntry = vi.fn();
  render(
    <Account
      compactEntry
      onAuthenticated={authenticated}
      renderEntry={renderEntry}
    />,
  );
  await waitFor(() =>
    expect(authenticated).toHaveBeenCalledExactlyOnceWith(me),
  );
  expect(api).toHaveBeenCalledTimes(1);
  expect(renderEntry).not.toHaveBeenCalled();
});
