import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import MapPanel from './map';

const api = vi.hoisted(() => vi.fn());
vi.mock('../lib/client', () => ({ api }));
vi.mock('./map-canvas', () => ({
  default: ({ markers }: { markers: unknown[] }) => (
    <p>Меток: {markers.length}</p>
  ),
}));

afterEach(() => {
  cleanup();
  api.mockReset();
});

test('clears stale map markers and retries with the current filter', async () => {
  api
    .mockResolvedValueOnce({ markers: [{}], truncated: false })
    .mockRejectedValueOnce(new Error('Метки недоступны'))
    .mockResolvedValueOnce({ markers: [{}], truncated: false });
  const onBounds = vi.fn();
  const onSelect = vi.fn();
  const view = render(
    <MapPanel definition={{}} onBounds={onBounds} onSelect={onSelect} />,
  );
  await screen.findByText('Меток: 1');
  view.rerender(
    <MapPanel
      definition={{ regionCode: 'novosibirsk' }}
      onBounds={onBounds}
      onSelect={onSelect}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Метки недоступны',
  );
  await screen.findByText('Меток: 0');
  fireEvent.click(
    screen.getByRole('button', { name: 'Повторить загрузку карты' }),
  );
  await screen.findByText('Меток: 1');
  expect(api.mock.calls[2]?.[2]).toMatchObject({ regionCode: 'novosibirsk' });
});
