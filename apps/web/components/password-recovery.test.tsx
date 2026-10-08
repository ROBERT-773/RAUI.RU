import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PasswordRecovery from './password-recovery';
import { StrictMode } from 'react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});

test('A browser storage write failure cannot turn a successful reset into an error', async () => {
  window.history.replaceState(
    null,
    '',
    '/account/reset-password#token=' + 'c'.repeat(43),
  );
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage unavailable', 'QuotaExceededError');
  });
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  }));
  render(<PasswordRecovery confirm />);
  for (const label of ['Новый пароль', 'Повторите пароль'])
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: 'new-synthetic-password' },
    });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
  await screen.findByText('Пароль изменён. Войдите с новым паролем.');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByLabelText('Новый пароль')).toBeNull();
});

test('Requests recovery without revealing whether an account exists or allowing duplicate submission', async () => {
  let finish: (() => void) | undefined;
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push([url, JSON.parse(init.body as string)]);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ok: true, json: async () => ({ accepted: true }) };
  });
  render(<PasswordRecovery />);
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'person@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  expect(
    (screen.getByRole('button', { name: 'Отправляем…' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  finish!();
  await screen.findByText(
    'Если аккаунт с этим email существует, мы отправим ссылку для восстановления. Ссылка действует 15 минут.',
  );
  expect(requests).toEqual([
    ['/api/v1/auth/password-reset', { email: 'person@example.test' }],
  ]);
});

test('Consumes a fragment token, checks password confirmation and returns to login after reset', async () => {
  const token = 'a'.repeat(43);
  window.history.replaceState(
    null,
    '',
    '/account/reset-password#token=' + token,
  );
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push([url, JSON.parse(init.body as string)]);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  render(
    <StrictMode>
      <PasswordRecovery confirm />
    </StrictMode>,
  );
  expect(window.location.hash).toBe('');
  fireEvent.change(screen.getByLabelText('Новый пароль'), {
    target: { value: 'new-synthetic-password' },
  });
  fireEvent.change(screen.getByLabelText('Повторите пароль'), {
    target: { value: 'different-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
  expect(screen.getByRole('alert').textContent).toBe('Пароли не совпадают.');
  expect(requests).toEqual([]);
  fireEvent.change(screen.getByLabelText('Повторите пароль'), {
    target: { value: 'new-synthetic-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
  await screen.findByText('Пароль изменён. Войдите с новым паролем.');
  expect(
    screen.getByRole('link', { name: 'Войти в аккаунт' }).getAttribute('href'),
  ).toBe('/account');
  expect(requests).toEqual([
    [
      '/api/v1/auth/password-reset/confirm',
      { token, password: 'new-synthetic-password' },
    ],
  ]);
});

test('Rejects a missing token without showing a password form', () => {
  render(<PasswordRecovery confirm />);
  expect(screen.getByRole('alert').textContent).toContain(
    'Ссылка недействительна',
  );
  expect(screen.queryByLabelText('Новый пароль')).toBeNull();
});

test('Rejects malformed fragment tokens', () => {
  window.history.replaceState(
    null,
    '',
    '/account/reset-password#token=invalid',
  );
  render(<PasswordRecovery confirm />);
  expect(screen.getByRole('alert').textContent).toContain(
    'Ссылка недействительна',
  );
  expect(screen.queryByLabelText('Новый пароль')).toBeNull();
  expect(window.location.hash).toBe('');
});

for (const length of [11, 129])
  test(`Rejects a password of ${length} characters before calling the API`, () => {
    window.history.replaceState(
      null,
      '',
      '/account/reset-password#token=' + 'd'.repeat(43),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<PasswordRecovery confirm />);
    for (const label of ['Новый пароль', 'Повторите пароль'])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: 'x'.repeat(length) },
      });
    fireEvent.submit(screen.getByLabelText('Новый пароль').closest('form')!);
    expect(screen.getByRole('alert').textContent).toContain('от 12 до 128');
    expect(fetch).not.toHaveBeenCalled();
  });

test('A request failure offers retry without claiming email delivery', async () => {
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }));
  render(<PasswordRecovery />);
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'person@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Попробуйте позже',
  );
  expect(
    (
      screen.getByRole('button', {
        name: 'Отправить ссылку',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test('Shows an actionable invalid or expired link error without exposing response details', async () => {
  window.history.replaceState(
    null,
    '',
    '/account/reset-password#token=' + 'b'.repeat(43),
  );
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 400 }));
  render(<PasswordRecovery confirm />);
  for (const label of ['Новый пароль', 'Повторите пароль'])
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: 'new-synthetic-password' },
    });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Запросите новую ссылку',
  );
});
