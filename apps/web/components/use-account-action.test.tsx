import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../lib/client';
import { useAccountAction } from './use-account-action';

const form = vi.hoisted(() => ({
  authenticated: undefined as (() => void) | undefined,
}));
vi.mock('./account-entry-link', () => ({
  AccountEntryDialog: ({
    title,
    onAuthenticated,
    onClose,
  }: {
    title: string;
    onAuthenticated: () => void;
    onClose: () => void;
  }) => {
    form.authenticated = onAuthenticated;
    return (
      <dialog open aria-label={title}>
        <button onClick={onClose}>Закрыть</button>
      </dialog>
    );
  },
}));

function Actions({
  save,
  report,
}: {
  save: () => Promise<void>;
  report: (message: string) => void;
}) {
  const { run, dialog } = useAccountAction(report);
  return (
    <>
      <button onClick={(event) => run(event, 'Для сохранения', save)}>
        Сохранить
      </button>
      {dialog}
    </>
  );
}

afterEach(() => {
  cleanup();
  form.authenticated = undefined;
  window.history.replaceState(null, '', '/');
});

test('runs a protected action once after a 401, even with repeated clicks and authentication callbacks', async () => {
  window.history.replaceState({ test: true }, '', '/search?q=метро#filters');
  const url = location.href;
  const save = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new ApiError('Гость', 401))
    .mockResolvedValue(undefined);
  const report = vi.fn();
  render(<Actions save={save} report={report} />);
  const trigger = screen.getByRole('button', { name: 'Сохранить' });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  await screen.findByRole('dialog');
  expect(save).toHaveBeenCalledTimes(1);
  expect(location.href).toBe(url);
  const resume = form.authenticated!;
  act(() => {
    resume();
    resume();
  });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(history.state).toEqual({ test: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(location.href).toBe(url);
  expect(report).not.toHaveBeenCalled();
});

test.each(['close', 'back'])(
  'discards a cancelled action on %s and ignores Forward and a late login',
  async (method) => {
    window.history.replaceState({ base: true }, '', '/search?q=дом');
    const save = vi.fn().mockRejectedValue(new ApiError('Гость', 401));
    render(<Actions save={save} report={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Сохранить' });
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    const resume = form.authenticated!;
    if (method === 'close') fireEvent.click(screen.getByText('Закрыть'));
    else act(() => history.back());
    await waitFor(() => expect(history.state).toEqual({ base: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => history.forward());
    await waitFor(() => expect(history.state.rauiAccountAction).toBeTruthy());
    act(() => resume());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  },
);

test('reports ordinary failures and a second 401 without another login loop', async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new ApiError('Конфликт', 409))
    .mockRejectedValue(new ApiError('Сессия истекла', 401));
  const report = vi.fn();
  render(<Actions save={save} report={report} />);
  const trigger = screen.getByRole('button', { name: 'Сохранить' });
  fireEvent.click(trigger);
  await waitFor(() => expect(report).toHaveBeenCalledWith('Конфликт'));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  await screen.findByRole('dialog');
  act(() => form.authenticated!());
  await waitFor(() => expect(report).toHaveBeenCalledWith('Сессия истекла'));
  await waitFor(() => expect(history.state?.rauiAccountAction).toBeUndefined());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(save).toHaveBeenCalledTimes(3);
});
