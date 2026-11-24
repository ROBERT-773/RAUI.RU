import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DetailActions from './detail-actions';
import { api } from '../lib/client';

vi.mock('../lib/client', () => ({ api: vi.fn(), track: vi.fn() }));
beforeEach(() => vi.mocked(api).mockResolvedValue({}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test('messages-only listing offers a message without fetching telephone numbers', () => {
  render(<DetailActions id="listing" messagesAllowed callsAllowed={false} />);
  expect(screen.getByLabelText('Сообщение продавцу')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Показать телефон' })).toBeNull();
  expect(api).not.toHaveBeenCalledWith('v1/listings/listing/public/contact');
});

test('a guest reveals both current numbers in order on a calls-only listing', async () => {
  render(<DetailActions id="listing" messagesAllowed={false} callsAllowed />);
  expect(screen.queryByLabelText('Сообщение продавцу')).toBeNull();
  expect(screen.queryByRole('link', { name: /Телефон/ })).toBeNull();
  vi.mocked(api).mockResolvedValueOnce({
    messagesAllowed: false,
    phones: ['+74950000002', '+74950000001'],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Показать телефон' }));
  const links = await screen.findAllByRole('link', { name: /Телефон [12]/ });
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    'tel:+74950000002',
    'tel:+74950000001',
  ]);
  expect(api).toHaveBeenCalledWith('v1/listings/listing/public/contact');
});

test('when calls were disabled after opening the card, reveal offers the current message option', async () => {
  render(<DetailActions id="listing" messagesAllowed={false} callsAllowed />);
  vi.mocked(api).mockResolvedValueOnce({ phones: [], messagesAllowed: true });
  fireEvent.click(screen.getByRole('button', { name: 'Показать телефон' }));
  await screen.findByLabelText('Сообщение продавцу');
  expect(screen.queryByRole('link', { name: /Телефон/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Показать телефон' })).toBeNull();
});
