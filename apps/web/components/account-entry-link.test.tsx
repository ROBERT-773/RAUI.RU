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
import { AccountEntryLink } from './account-entry-link';
import AuthDialog from './auth-dialog';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.resetAllMocks();
});

test('opens immediately on the current URL, and one Back dismisses a double-click and restores focus', async () => {
  vi.mocked(api).mockReturnValue(new Promise(() => {}));
  window.history.replaceState(null, '', '/search?city=77#map');
  const length = history.length;
  render(
    <AccountEntryLink href="/account/listings#new-listing" intent="publish">
      Разместить объявление
    </AccountEntryLink>,
  );
  const trigger = screen.getByRole('link', { name: 'Разместить объявление' });
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(
    screen.getByRole('dialog', {
      name: 'Войдите, чтобы разместить объявление',
    }),
  ).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Открываем форму входа…');
  expect(
    window.location.pathname + window.location.search + window.location.hash,
  ).toBe('/search?city=77#map');
  expect(history.length).toBe(length + 1);
  expect(
    screen.getByRole('link', { name: 'Служба поддержки' }).getAttribute('href'),
  ).toBe('/support');
  act(() => history.back());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test('Escape on the code dialog leaves the outer dialog open', () => {
  const close = vi.fn();
  render(
    <AuthDialog title="Вход или регистрация" onClose={close}>
      <dialog open aria-label="Код" />
    </AuthDialog>,
  );
  fireEvent(
    screen.getByRole('dialog', { name: 'Код' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(close).not.toHaveBeenCalled();
  fireEvent(
    screen.getByRole('dialog', { name: 'Вход или регистрация' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(close).toHaveBeenCalledOnce();
});
