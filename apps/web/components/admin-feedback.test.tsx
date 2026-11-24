import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../lib/client';
import AdminFeedback from './admin-feedback';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const first = {
  id: 'first',
  message: 'Показывайте школу рядом с домом.',
  authorId: '8001',
  createdAt: '2026-10-02T12:00:00.000Z',
};
const second = { ...first, id: 'second', message: 'Добавьте поиск по паркам.' };

test('an admin reads dated suggestions in server order and retries a failed next page', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ items: [first], nextCursor: 'item+2' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [second], nextCursor: null });
  render(<AdminFeedback />);
  await screen.findByText(first.message);
  expect(screen.getByText('ID пользователя 8001')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByRole('alert');
  expect(screen.getByText(first.message)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await screen.findByText(second.message);
  expect(
    screen
      .getAllByRole('listitem')
      .map((item) => item.querySelector('p')?.textContent),
  ).toEqual([first.message, second.message]);
  expect(api).toHaveBeenLastCalledWith('v1/admin/feedback?cursor=item%2B2');
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
});

test('an administrator losing access no longer sees previously loaded proposals', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ items: [first], nextCursor: 'page2' })
    .mockRejectedValueOnce(new ApiError('denied', 403));
  render(<AdminFeedback />);
  await screen.findByText(first.message);
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(first.message)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
});
