import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { api, ApiError } from '../lib/client';
import AdminFeedTrust from './admin-feed-trust';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const path = 'v1/admin/integrations/feeds';
const source = {
  id: 'source-1',
  ownerName: 'Агентство Север',
  provider: 'cian',
  host: 'feeds.example',
  active: true,
  version: 2,
  trustEligible: true,
  trusted: false,
};
test('explicit decisions send the current source version and present the server decision', async () => {
  const trusted = { ...source, trusted: true, version: 3 };
  vi.mocked(api)
    .mockResolvedValueOnce([source])
    .mockResolvedValueOnce(trusted)
    .mockResolvedValueOnce({ ...source, version: 4 });
  render(<AdminFeedTrust />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Разрешить автопубликацию' }),
  );
  await screen.findByText('Автопубликация разрешена');
  expect(api).toHaveBeenCalledWith(path + '/source-1/trust', 'PATCH', {
    version: 2,
    trusted: true,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отозвать разрешение' }));
  await screen.findByRole('button', { name: 'Разрешить автопубликацию' });
  expect(api).toHaveBeenCalledWith(path + '/source-1/trust', 'PATCH', {
    version: 3,
    trusted: false,
  });
});
test('conflicting decisions refresh the page and block approval until this version passes preview', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce([source])
    .mockRejectedValueOnce(new ApiError('private', 409))
    .mockResolvedValueOnce([{ ...source, version: 3, trustEligible: false }]);
  render(<AdminFeedTrust />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Разрешить автопубликацию' }),
  );
  await screen.findByText(/Нужна предварительная проверка/);
  expect(
    screen.queryByRole('button', { name: 'Разрешить автопубликацию' }),
  ).toBeNull();
  expect(screen.queryByText(/private/)).toBeNull();
});
test('an admin can reach managed sources beyond a full page of legacy feeds', async () => {
  const legacy = Array.from({ length: 100 }, (_, index) => ({
    id: 'legacy-' + index,
    provider: null,
  }));
  vi.mocked(api).mockResolvedValueOnce(legacy).mockResolvedValueOnce([source]);
  render(<AdminFeedTrust />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Следующая страница' }),
  );
  await screen.findByText('Агентство Север');
  expect(api).toHaveBeenCalledWith(path + '?after=legacy-99');
});
test('access denial clears previously visible admin controls', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce([source])
    .mockRejectedValueOnce(new ApiError('private', 403));
  render(<AdminFeedTrust />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Разрешить автопубликацию' }),
  );
  await waitFor(() => expect(screen.queryByText('Агентство Север')).toBeNull());
  expect(screen.getByRole('alert').textContent).toMatch(/прав/i);
});
