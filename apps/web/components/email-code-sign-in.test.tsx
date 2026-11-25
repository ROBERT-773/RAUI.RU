import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../lib/client';
import EmailCodeSignIn from './email-code-sign-in';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const path = 'v1/auth/email-sign-in';
const challenge = {
  challengeId: 'email-test',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  resendAfter: new Date(Date.now() + 60000).toISOString(),
};
const session = { user: { role: 'buyer' }, csrfToken: 'test-session' };
test.each([undefined, 'agency'] as const)(
  'requests a code explicitly and completes sign-in with registrationRole %s and no password',
  async (role) => {
    vi.mocked(api)
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(session);
    const done = vi.fn();
    render(<EmailCodeSignIn onSession={done} onOther={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'guest@example.test' },
    });
    if (role) {
      fireEvent.click(screen.getByText('Роль при регистрации'));
      fireEvent.change(screen.getByRole('combobox', { name: 'Кто вы?' }), {
        target: { value: role },
      });
    }
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await screen.findByRole('dialog', { name: 'Подтверждение почты' });
    const proof = {
      email: 'guest@example.test',
      browserKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    };
    expect(api).toHaveBeenCalledWith(path, 'POST', proof, {
      idempotencyKey: expect.any(String),
    });
    expect(screen.queryByLabelText('Пароль')).toBeNull();
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Код подтверждения'), {
        target: { value: '000234' },
      }),
    );
    expect(api).toHaveBeenLastCalledWith(path + '/confirm', 'POST', {
      ...proof,
      challengeId: 'email-test',
      code: '000234',
      ...(role ? { registrationRole: role } : {}),
    });
    expect(done).toHaveBeenCalledExactlyOnceWith(session);
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
test('keeps alternative sign-in available after a temporary delivery failure', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('unavailable', 503));
  const other = vi.fn();
  render(<EmailCodeSignIn onSession={vi.fn()} onOther={other} />);
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'guest@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(
    /не удалось отправить код/i,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Другой способ' }));
  expect(other).toHaveBeenCalledOnce();
});

test('recovery requests an existing account and never offers a registration role', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce(challenge)
    .mockResolvedValueOnce(session);
  const done = vi.fn();
  render(<EmailCodeSignIn recoveryMode onSession={done} onOther={vi.fn()} />);
  expect(
    screen.getByRole('heading', { name: 'Восстановить доступ' }),
  ).toBeTruthy();
  expect(screen.queryByText('Роль при регистрации')).toBeNull();
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'known@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  const field = await screen.findByLabelText('Код подтверждения');
  await act(async () =>
    fireEvent.change(field, { target: { value: '000234' } }),
  );
  expect(api).toHaveBeenLastCalledWith(
    path + '/confirm',
    'POST',
    expect.objectContaining({ existingOnly: true, code: '000234' }),
  );
  expect(done).toHaveBeenCalledOnce();
});

test('on return from the mailbox an expired code is never submitted and a new one can be requested', async () => {
  vi.useFakeTimers();
  try {
    const start = Date.parse('2026-01-02T09:00:00Z');
    vi.setSystemTime(start);
    vi.mocked(api).mockResolvedValueOnce({
      ...challenge,
      expiresAt: new Date(start + 3600000).toISOString(),
      resendAfter: new Date(start + 60000).toISOString(),
    });
    render(<EmailCodeSignIn onOther={vi.fn()} onSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'guest@example.test' },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Получить код' })),
    );
    expect(screen.getByText(/Код действует до/)).toBeTruthy();
    vi.setSystemTime(start + 3600001);
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText(/Срок действия кода истёк/)).toBeTruthy();
    const field = screen.getByLabelText(
      'Код подтверждения',
    ) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    fireEvent.change(field, { target: { value: '000234' } });
    expect(api).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole('button', {
          name: 'Отправить новый код',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
