import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import PhoneOtpForm from './phone-otp-form';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
const allocation = (delivery = 'accepted') => ({
  challengeId: '11111111-1111-4111-8111-111111111111',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  resendAfter: new Date(Date.now() + 60_000).toISOString(),
  delivery,
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function request() {
  fireEvent.change(screen.getByLabelText('Номер телефона для SMS'), {
    target: { value: '+79991234567' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Запросить SMS-код' }));
}
for (const [delivery, copy] of [
  ['accepted', 'Запрос на отправку SMS принят. Доставка не подтверждена.'],
  [
    'unknown',
    'Не удалось подтвердить отправку. Если SMS придёт, используйте код.',
  ],
  ['unavailable', 'SMS сейчас недоступно. Повторите запрос позже.'],
] as const)
  test(`dispatch ${delivery} is bounded and never implies verification`, async () => {
    vi.mocked(api).mockResolvedValue(allocation(delivery));
    render(<PhoneOtpForm onConfirmed={vi.fn()} />);
    await request();
    await screen.findByText(copy);
    expect(screen.queryByText('Контакт подтверждён.')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Повторить запрос SMS-кода',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(api).toHaveBeenCalledWith(
      'v1/auth/verification/phone/otp',
      'POST',
      { phone: '+79991234567' },
      { idempotencyKey: expect.any(String) },
    );
  });
test('six digit text preserves leading zeroes, clears code and refreshes authoritative profile', async () => {
  const confirmed = vi.fn();
  vi.mocked(api)
    .mockResolvedValueOnce(allocation())
    .mockResolvedValueOnce({ verified: true });
  render(<PhoneOtpForm onConfirmed={confirmed} />);
  await request();
  await screen.findByText(/Запрос на отправку SMS принят/);
  const input = screen.getByLabelText('SMS-код из 6 цифр') as HTMLInputElement;
  expect(input.type).toBe('text');
  expect(input.inputMode).toBe('numeric');
  expect(input.autocomplete).toBe('one-time-code');
  fireEvent.change(input, { target: { value: '000123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить SMS-код' }));
  await act(async () => {});
  expect(api).toHaveBeenCalledWith(
    'v1/auth/verification/phone/otp/confirm',
    'POST',
    { challengeId: allocation().challengeId, code: '000123' },
  );
  expect(input.value).toBe('');
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(localStorage.length).toBe(0);
});
test('duplicate submissions allocate once and unmounted result cannot expose challenge', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const confirmed = vi.fn();
  const view = render(<PhoneOtpForm onConfirmed={confirmed} />);
  await request();
  fireEvent.submit(
    screen.getByLabelText('Номер телефона для SMS').closest('form')!,
  );
  expect(api).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => finish(allocation()));
  expect(confirmed).not.toHaveBeenCalled();
});
test('unmounted confirmation cannot refresh a new identity', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api)
    .mockResolvedValueOnce(allocation())
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const confirmed = vi.fn();
  const view = render(<PhoneOtpForm onConfirmed={confirmed} />);
  await request();
  await screen.findByText(/Запрос на отправку SMS принят/);
  fireEvent.change(screen.getByLabelText('SMS-код из 6 цифр'), {
    target: { value: '000123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить SMS-код' }));
  view.unmount();
  await act(async () => finish({ verified: true }));
  expect(confirmed).not.toHaveBeenCalled();
});
test('expired challenge refuses confirmation and clears code', async () => {
  vi.useFakeTimers();
  vi.mocked(api).mockResolvedValue({
    ...allocation(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  });
  render(<PhoneOtpForm onConfirmed={vi.fn()} />);
  await request();
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('SMS-код из 6 цифр'), {
    target: { value: '000123' },
  });
  await act(async () => vi.advanceTimersByTime(2000));
  expect(
    (
      screen.getByRole('button', {
        name: 'Подтвердить SMS-код',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText('SMS-код из 6 цифр') as HTMLInputElement).value,
  ).toBe('');
  expect(api).toHaveBeenCalledTimes(1);
});
test('429 server cooldown prevents new allocation until retry boundary', async () => {
  vi.useFakeTimers();
  vi.mocked(api)
    .mockRejectedValueOnce(
      Object.assign(new Error('Повторите позже'), {
        status: 429,
        retryAfterSeconds: 7,
      }),
    )
    .mockResolvedValueOnce(allocation());
  render(<PhoneOtpForm onConfirmed={vi.fn()} />);
  await request();
  await act(async () => {});
  const button = screen.getByRole('button', {
    name: 'Запросить SMS-код',
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(7000));
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(2);
});
test('uncertain network outcome retries same allocation key and body without automatic resend', async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error('Сеть недоступна'))
    .mockResolvedValueOnce(allocation('unknown'));
  render(<PhoneOtpForm onConfirmed={vi.fn()} />);
  await request();
  await screen.findByRole('alert');
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Проверить результат запроса' }),
  );
  await screen.findByText(/Не удалось подтвердить отправку/);
  expect(vi.mocked(api).mock.calls[1]).toEqual(vi.mocked(api).mock.calls[0]);
});

test('old identity allocation cannot leak into remounted phone form', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const confirmed = vi.fn();
  const view = render(<PhoneOtpForm key="first" onConfirmed={confirmed} />);
  await request();
  view.rerender(<PhoneOtpForm key="second" onConfirmed={confirmed} />);
  await act(async () => finish(allocation()));
  expect(
    (screen.getByLabelText('Номер телефона для SMS') as HTMLInputElement).value,
  ).toBe('');
  expect(screen.queryByLabelText('SMS-код из 6 цифр')).toBeNull();
  expect(screen.queryByText(/Запрос на отправку SMS принят/)).toBeNull();
});
test('malformed allocation never exposes a challenge or claims SMS dispatch', async () => {
  vi.mocked(api).mockResolvedValue({
    ...allocation(),
    delivery: 'constructor',
  });
  render(<PhoneOtpForm onConfirmed={vi.fn()} />);
  await request();
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('SMS-код из 6 цифр')).toBeNull();
  expect(screen.queryByText(/Доставка не подтверждена/)).toBeNull();
});
test('wrong code clears entered digits, leaves confirmation available and does not refresh profile', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce(allocation())
    .mockRejectedValueOnce(new Error('Код недействителен'));
  const confirmed = vi.fn();
  render(<PhoneOtpForm onConfirmed={confirmed} />);
  await request();
  await screen.findByLabelText('SMS-код из 6 цифр');
  fireEvent.change(screen.getByLabelText('SMS-код из 6 цифр'), {
    target: { value: '000123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить SMS-код' }));
  await screen.findByRole('alert');
  expect(
    (screen.getByLabelText('SMS-код из 6 цифр') as HTMLInputElement).value,
  ).toBe('');
  expect(confirmed).not.toHaveBeenCalled();
});

test('explicit resend after server cooldown uses a new allocation key and clears old code', async () => {
  vi.useFakeTimers();
  vi.mocked(api).mockImplementation(async () => allocation());
  render(<PhoneOtpForm onConfirmed={vi.fn()} />);
  await request();
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('SMS-код из 6 цифр'), {
    target: { value: '000123' },
  });
  await act(async () => vi.advanceTimersByTime(60_000));
  fireEvent.click(
    screen.getByRole('button', { name: 'Повторить запрос SMS-кода' }),
  );
  await act(async () => {});
  expect(api).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api).mock.calls[1]?.[3]?.idempotencyKey).not.toBe(
    vi.mocked(api).mock.calls[0]?.[3]?.idempotencyKey,
  );
  expect(
    (screen.getByLabelText('SMS-код из 6 цифр') as HTMLInputElement).value,
  ).toBe('');
});
for (const status of [401, 503])
  test(`OTP request failure ${status} expires only unauthorized sessions`, async () => {
    vi.mocked(api).mockRejectedValue(
      Object.assign(new Error('Запрос недоступен'), { status }),
    );
    const expired = vi.fn();
    render(<PhoneOtpForm onConfirmed={vi.fn()} onSessionExpired={expired} />);
    await request();
    await screen.findByRole('alert');
    expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(screen.queryByLabelText('SMS-код из 6 цифр')).toBeNull();
  });
