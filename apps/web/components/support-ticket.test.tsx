import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NewSupportTicket, TicketStatus } from './support-ticket';
import { api } from '../lib/client';

vi.mock('../lib/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});
test('a complaint keeps its listing and reuses the same private receipt when the response is lost', async () => {
  const id = crypto.randomUUID();
  vi.mocked(api)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ id: crypto.randomUUID() });
  render(
    <NewSupportTicket initialTopic="complaint" listingId={id} articles={[]} />,
  );
  fireEvent.change(screen.getByLabelText('Сообщение'), {
    target: { value: 'Исправьте адрес дома' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить обращение' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Отправить обращение' }));
  const link = await screen.findByRole('link', {
    name: 'Открыть моё обращение',
  });
  const first = vi.mocked(api).mock.calls[0]!;
  expect(first).toEqual(vi.mocked(api).mock.calls[1]);
  expect(first[2]).toMatchObject({
    listingId: id,
    topic: 'complaint',
    message: 'Исправьте адрес дома',
  });
  expect(link.getAttribute('href')).toBe(
    '/support/status#' + (first[2] as { receipt: string }).receipt,
  );
});
test('a personal link retrieves the reply and omits the receipt from the API URL', async () => {
  const receipt = crypto.randomUUID();
  window.history.replaceState(null, '', '/support/status#' + receipt);
  vi.mocked(api).mockResolvedValueOnce({
    topic: 'login',
    message: 'Вопрос о кабинете',
    reply: 'Ответ от поддержки',
  });
  render(<TicketStatus />);
  await screen.findByText('Ответ от поддержки');
  expect(api).toHaveBeenCalledWith('v1/support/tickets/status', 'POST', {
    receipt,
  });
});
test('opens the help message for a missing private link', async () => {
  render(<TicketStatus />);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('личную ссылку'),
  );
  expect(api).not.toHaveBeenCalled();
});
