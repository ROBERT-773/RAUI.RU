import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../lib/client';
import PhoneSignIn from './phone-sign-in';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
const path = 'v1/auth/phone-sign-in';
const challenge = { challengeId: 'test-challenge', delivery: 'accepted' };
const session = {
  kind: 'session',
  user: { id: 'test-user' },
  csrfToken: 'test-csrf',
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function begin() {
  const number = screen.getByRole('textbox', { name: 'Мобильный телефон' });
  fireEvent.change(number, { target: { value: '8 (900) 123-45-67' } });
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  return number;
}
const confirmed = () =>
  vi.mocked(api).mock.calls.filter(([url]) => url === path + '/confirm');
test('opens an accessible code dialog, takes a pasted six-digit code and submits it once', async () => {
  const done = vi.fn(),
    pending = deferred<typeof session>();
  vi.mocked(api)
    .mockResolvedValueOnce(challenge)
    .mockImplementationOnce(() => pending.promise);
  render(<PhoneSignIn onSession={done} onOther={vi.fn()} />);
  const user = userEvent.setup();
  await begin();
  const dialog = await screen.findByRole('dialog', {
    name: 'Подтверждение телефона',
  });
  const field = within(dialog).getByRole('textbox', {
    name: 'Код подтверждения',
  });
  expect(document.activeElement).toBe(field);
  expect(field.getAttribute('autocomplete')).toBe('one-time-code');
  expect(
    within(dialog).getByText(/Введите код из сообщения или уведомления/),
  ).toBeTruthy();
  expect(
    within(dialog).queryByRole('button', { name: 'Подтвердить код' }),
  ).toBeNull();
  await user.paste('0123456');
  expect(confirmed()).toHaveLength(0);
  await user.paste('012 345');
  expect(confirmed()).toHaveLength(1);
  fireEvent.submit(field.closest('form')!);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(confirmed()[0]).toEqual([
    path + '/confirm',
    'POST',
    {
      code: '012345',
      phone: '+79001234567',
      browserKey: expect.any(String),
      challengeId: 'test-challenge',
    },
  ]);
  await act(async () => pending.resolve(session));
  expect(done).toHaveBeenCalledExactlyOnceWith(session);
});
test('partial codes do not submit; network errors allow manually retrying the same code, then signup can finish', async () => {
  const done = vi.fn();
  vi.mocked(api)
    .mockResolvedValueOnce({ ...challenge, delivery: 'unknown' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ kind: 'signup', signupToken: 'proof' })
    .mockResolvedValueOnce(session);
  render(<PhoneSignIn onSession={done} onOther={vi.fn()} />);
  await begin();
  const field = await screen.findByLabelText('Код подтверждения');
  fireEvent.input(field, { target: { value: '01234' } });
  expect(confirmed()).toHaveLength(0);
  fireEvent.input(field, { target: { value: '012345' } });
  await screen.findByRole('alert');
  expect(confirmed()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить код' }));
  const role = await screen.findByLabelText('Кто вы?');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.change(role, { target: { value: 'owner' } });
  fireEvent.change(screen.getByLabelText('Имя'), {
    target: { value: 'Гость' },
  });
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'guest@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'example-password-42' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
  await act(async () => {});
  expect(confirmed()).toHaveLength(2);
  expect(api).toHaveBeenLastCalledWith(
    path + '/register',
    'POST',
    expect.objectContaining({ signupToken: 'proof', role: 'owner' }),
  );
  expect(done).toHaveBeenCalledExactlyOnceWith(session);
});
test('closes or changes the number before verification, focuses the phone and ignores stale delivery', async () => {
  const old = deferred<typeof challenge>(),
    onOther = vi.fn(),
    onSession = vi.fn();
  vi.mocked(api)
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValue({ ...challenge, challengeId: 'fresh' });
  render(<PhoneSignIn onOther={onOther} onSession={onSession} />);
  const phone = await begin();
  expect((phone as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(phone, { target: { value: '+79001234568' } });
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  await screen.findByRole('dialog');
  await act(async () => old.resolve({ ...challenge, delivery: 'unavailable' }));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(screen.getByLabelText('Код подтверждения'), {
    target: { value: '01' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить номер' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(phone);
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  const reopened = await screen.findByRole('dialog');
  expect(
    (screen.getByLabelText('Код подтверждения') as HTMLInputElement).value,
  ).toBe('');
  fireEvent(reopened, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Другой способ' }));
  expect(onOther).toHaveBeenCalledOnce();
  expect(confirmed()).toHaveLength(0);
  expect(onSession).not.toHaveBeenCalled();
});
test('a rejected code allows a corrected code to be confirmed once', async () => {
  const done = vi.fn();
  vi.mocked(api)
    .mockResolvedValueOnce(challenge)
    .mockRejectedValueOnce(new ApiError('invalid', 401))
    .mockResolvedValueOnce(session);
  render(<PhoneSignIn onOther={vi.fn()} onSession={done} />);
  await begin();
  const field = await screen.findByLabelText('Код подтверждения');
  fireEvent.change(field, { target: { value: '123456' } });
  await screen.findByText('Код неверный или истёк.');
  fireEvent.change(field, { target: { value: '123457' } });
  await act(async () => {});
  expect(confirmed()).toHaveLength(2);
  expect(done).toHaveBeenCalledOnce();
});

test('recovery for an unknown phone returns to the number without creating an account', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce(challenge)
    .mockResolvedValueOnce({ kind: 'signup', signupToken: 'test-proof' });
  const done = vi.fn();
  render(<PhoneSignIn recoveryMode onOther={vi.fn()} onSession={done} />);
  expect(
    screen.getByRole('heading', { name: 'Восстановить доступ' }),
  ).toBeTruthy();
  const phone = await begin();
  const field = await screen.findByLabelText('Код подтверждения');
  await act(async () =>
    fireEvent.change(field, { target: { value: '000234' } }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('Пароль')).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/проверьте номер/i);
  expect(document.activeElement).toBe(phone);
  expect(done).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledTimes(2);
});
test('enrolling an existing phone still needs the password and a deliberate submission', async () => {
  const enrolled = vi.fn();
  vi.mocked(api).mockResolvedValueOnce(challenge).mockResolvedValueOnce({});
  render(
    <PhoneSignIn
      enrollmentPhone="+79001234567"
      onEnrolled={enrolled}
      onOther={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  const code = await screen.findByLabelText('Код из SMS');
  fireEvent.change(code, { target: { value: '001234' } });
  expect(vi.mocked(api).mock.calls).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Текущий пароль'), {
    target: { value: 'test-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
  await act(async () => {});
  expect(api).toHaveBeenLastCalledWith(
    path + '/enroll',
    'POST',
    expect.objectContaining({ code: '001234', password: 'test-password' }),
  );
  expect(enrolled).toHaveBeenCalledOnce();
});

test('a delayed resend for a previous phone cannot replace a new session', async () => {
  const old = {
    ...challenge,
    resendAfter: new Date(Date.now() - 5000).toISOString(),
  };
  const delayed = deferred<typeof old>();
  const next = { ...old, challengeId: 'current' };
  const done = vi.fn();
  vi.mocked(api)
    .mockResolvedValueOnce(old)
    .mockImplementationOnce(() => delayed.promise)
    .mockResolvedValueOnce(next)
    .mockResolvedValueOnce(session);
  render(<PhoneSignIn onOther={vi.fn()} onSession={done} />);
  const number = await begin();
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Отправить новый код' }));
  fireEvent.click(screen.getByRole('button', { name: 'Изменить номер' }));
  fireEvent.change(number, { target: { value: '+79001234569' } });
  fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
  const field = await screen.findByLabelText('Код подтверждения');
  await act(async () =>
    fireEvent.input(field, { target: { value: '001239' } }),
  );
  await act(async () => delayed.resolve({ ...old, challengeId: 'stale' }));
  expect(done).toHaveBeenCalledExactlyOnceWith(session);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(confirmed()[0]?.[2]).toEqual(
    expect.objectContaining({ challengeId: 'current', phone: '+79001234569' }),
  );
});
test('a known unavailable delivery leaves an alternative sign-in and never opens a code dialog', async () => {
  vi.mocked(api).mockResolvedValueOnce({
    ...challenge,
    delivery: 'unavailable',
  });
  const other = vi.fn();
  render(<PhoneSignIn onOther={other} onSession={vi.fn()} />);
  await begin();
  await screen.findByRole('alert');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Другой способ' }));
  expect(other).toHaveBeenCalledOnce();
});

test('uses the server deadline and a new key for the next code, reusing that key after a lost response', async () => {
  vi.useFakeTimers();
  const issuedAt = new Date('2026-01-01T09:00:00.000Z').getTime();
  vi.setSystemTime(issuedAt);
  const first = {
    ...challenge,
    resendAfter: new Date(issuedAt + 3000).toISOString(),
  };
  const second = {
    ...first,
    challengeId: 'next',
    resendAfter: new Date(issuedAt + 64000).toISOString(),
  };
  const reply = deferred<typeof second>();
  vi.mocked(api)
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockImplementationOnce(() => reply.promise)
    .mockResolvedValueOnce(session);
  const done = vi.fn();
  render(<PhoneSignIn onOther={vi.fn()} onSession={done} />);
  await act(async () => {
    await begin();
  });
  const button = () =>
    screen.getByRole('button', {
      name: 'Отправить новый код',
    }) as HTMLButtonElement;
  const timer = () =>
    screen.getByRole('timer', { name: 'До повторной отправки' });
  expect(timer().textContent).toContain('0:03');
  expect(button().disabled).toBe(true);
  fireEvent.click(button());
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(button().disabled).toBe(false);
  await act(async () => fireEvent.click(button()));
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Проверить отправку' }));
  expect(vi.mocked(api).mock.calls[1]?.[3]?.idempotencyKey).not.toBe(
    vi.mocked(api).mock.calls[0]?.[3]?.idempotencyKey,
  );
  expect(vi.mocked(api).mock.calls[2]).toEqual(vi.mocked(api).mock.calls[1]);
  const field = screen.getByLabelText('Код подтверждения') as HTMLInputElement;
  expect(field.readOnly).toBe(true);
  fireEvent.change(field, { target: { value: '012345' } });
  expect(confirmed()).toHaveLength(0);
  await act(async () => reply.resolve(second));
  expect(button().disabled).toBe(true);
  expect(
    (screen.getByLabelText('Код подтверждения') as HTMLInputElement).value,
  ).toBe('');
  await act(async () =>
    fireEvent.input(screen.getByLabelText('Код подтверждения'), {
      target: { value: '012345' },
    }),
  );
  expect(confirmed()[0]?.[2]).toEqual(
    expect.objectContaining({ challengeId: 'next', code: '012345' }),
  );
  expect(done).toHaveBeenCalledOnce();
});
