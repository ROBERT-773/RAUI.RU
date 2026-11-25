import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import BetaInvitation from './beta-invitation';
import { api, ApiError } from '../lib/client';
import {
  readFeedbackDraft,
  storeFeedbackDraft,
  feedbackIdentityEvent,
} from '../lib/feedback-draft';

vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
const call = vi.mocked(api);
const open = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Оставить отзыв' }));
const send = () =>
  fireEvent.click(
    screen.getByRole('button', { name: 'Отправить предложение' }),
  );
const field = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Что бы вы хотели видеть на портале?',
  });
const message = 'Показывайте дату обновления фотографий.';
const user = { id: 'buyer-a' };
const draft = {
  message,
  requestId: '01234567-abcd-4bcd-abcd-0123456789ab',
  owner: user.id,
};

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
        this.querySelector('button')?.focus();
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.restoreAllMocks();
  call.mockReset();
  sessionStorage.clear();
  document.cookie = 'raui_beta_closed=; Max-Age=0; Path=/';
});

test('dismissal persists, feedback stays available and closing with Escape restores keyboard focus', async () => {
  call.mockRejectedValue(new ApiError('guest', 401));
  const initial = render(<BetaInvitation />);
  expect(
    screen
      .getByRole('link', { name: 'Разместить объявление' })
      .getAttribute('href'),
  ).toBe('/account/listings#new-listing');
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть приглашение' }));
  expect(document.cookie).toContain('raui_beta_closed=1');
  expect(screen.getByRole('button', { name: 'Оставить отзыв' })).toBe(
    document.activeElement,
  );
  initial.unmount();
  render(<BetaInvitation initialDismissed />);
  expect(
    screen.queryByRole('link', { name: 'Разместить объявление' }),
  ).toBeNull();
  open();
  expect(
    (
      await screen.findByRole('link', { name: 'Войти и продолжить' })
    ).getAttribute('href'),
  ).toBe('/account?action=feedback');
  expect(field()).toBe(document.activeElement);
  fireEvent(
    screen.getByRole('dialog'),
    new Event('cancel', { cancelable: true }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Оставить отзыв' })).toBe(
    document.activeElement,
  );
});

test('retry after lost response uses the same key even after reopening; the receipt clears the draft', async () => {
  let attempts = 0;
  call.mockImplementation(async (path) => {
    if (path === 'v1/auth/me') return user;
    if (++attempts === 1) throw new Error('simulated lost reply');
    return { id: 'receipt' };
  });
  render(<BetaInvitation initialOpen />);
  await screen.findByRole('button', { name: 'Отправить предложение' });
  fireEvent.change(field(), { target: { value: '  ' + message + '  ' } });
  send();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Не удалось подтвердить отправку',
  );
  const first = readFeedbackDraft();
  expect(first).toEqual({
    owner: user.id,
    message,
    requestId: expect.stringMatching(/^[a-f\d-]{36}$/i),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть форму' }));
  open();
  await screen.findByRole('button', { name: 'Отправить предложение' });
  expect(field().value).toBe(message);
  send();
  const receipt = await screen.findByText(
    'Спасибо! Ваше предложение отправлено команде RAUI.',
  );
  await waitFor(() => expect(document.activeElement).toBe(receipt));
  expect(readFeedbackDraft()).toBeNull();
  const payload = { message, requestId: first?.requestId };
  expect(
    call.mock.calls.filter(([path]) => path === 'v1/account/feedback'),
  ).toEqual([
    ['v1/account/feedback', 'POST', payload],
    ['v1/account/feedback', 'POST', payload],
  ]);
});

test('does not show a previous account’s draft and clears open feedback on a sign-out in another tab', async () => {
  storeFeedbackDraft(draft);
  call.mockResolvedValue({ id: 'buyer-b' });
  render(<BetaInvitation initialOpen />);
  await screen.findByRole('button', { name: 'Отправить предложение' });
  expect(field().value).toBe('');
  expect(readFeedbackDraft()).toBeNull();
  fireEvent.change(field(), { target: { value: 'Текст второго автора' } });
  fireEvent(
    window,
    new StorageEvent('storage', { key: feedbackIdentityEvent }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('when the account changes just before submission no text is posted for the new user', async () => {
  call.mockResolvedValueOnce(user).mockResolvedValueOnce({ id: 'buyer-b' });
  render(<BetaInvitation initialOpen />);
  await screen.findByRole('button', { name: 'Отправить предложение' });
  fireEvent.change(field(), { target: { value: message } });
  send();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Аккаунт изменился',
  );
  expect(field().value).toBe('');
  expect(call.mock.calls.every(([path]) => path === 'v1/auth/me')).toBe(true);
});

test('guest can explicitly keep the text across login, only in the current tab', async () => {
  call.mockRejectedValue(new ApiError('guest', 401));
  render(<BetaInvitation initialOpen />);
  const login = await screen.findByRole('link', { name: 'Войти и продолжить' });
  fireEvent.change(field(), { target: { value: message } });
  expect(readFeedbackDraft()).toBeNull();
  login.addEventListener('click', (event) => event.preventDefault(), {
    once: true,
  });
  fireEvent.click(login);
  expect(readFeedbackDraft()).toMatchObject({ owner: null, message });
  expect(JSON.stringify(localStorage)).not.toContain(message);
});

test('pending authors see their draft and cabinet link, then can continue after approval', async () => {
  call.mockResolvedValue({ ...user, registration_approval_state: 'pending' });
  storeFeedbackDraft(draft);
  render(<BetaInvitation initialOpen />);
  expect(
    (
      await screen.findByRole('link', { name: 'Проверить статус в кабинете' })
    ).getAttribute('href'),
  ).toBe('/account');
  expect(field().value).toBe(message);
  const updated = message + ' И порядок съёмки.';
  fireEvent.change(field(), { target: { value: updated } });
  expect(
    screen.queryByRole('button', { name: 'Отправить предложение' }),
  ).toBeNull();
  expect(readFeedbackDraft()).toMatchObject({
    owner: user.id,
    message: updated,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть форму' }));
  call.mockResolvedValue(user);
  open();
  await screen.findByRole('button', { name: 'Отправить предложение' });
  expect(field().value).toBe(updated);
});

test('a permission change after profile verification directs the author to the cabinet', async () => {
  call.mockImplementation(async (path) => {
    if (path === 'v1/auth/me') return user;
    throw new ApiError('forbidden', 403);
  });
  render(<BetaInvitation initialOpen />);
  await screen.findByRole('button', { name: 'Отправить предложение' });
  fireEvent.change(field(), { target: { value: message } });
  send();
  await screen.findByRole('link', { name: 'Проверить статус в кабинете' });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'отправка предложений недоступна',
  );
  expect(
    screen.queryByRole('button', { name: 'Отправить предложение' }),
  ).toBeNull();
});

test('transient session failure permits another check without enabling a guest submission', async () => {
  call.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(user);
  render(<BetaInvitation initialOpen />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Повторить проверку' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Отправить предложение' }),
    ).toBeTruthy(),
  );
  expect(field().value).toBe('');
});
