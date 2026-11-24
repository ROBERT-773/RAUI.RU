import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import MapPanel from './map';

const api = vi.hoisted(() => vi.fn());
vi.mock('../lib/client', () => ({ api }));
vi.mock('./map-canvas', () => ({
  default: ({ markers, bounds }: { markers: unknown[]; bounds: number[] }) => (
    <p data-bounds={bounds.join(',')}>Меток: {markers.length}</p>
  ),
}));

afterEach(() => {
  cleanup();
  api.mockReset();
});

test('fits the complete filtered extent before zooming into a selected city', async () => {
  const onBounds = vi.fn();
  api.mockResolvedValue({
    markers: [{ count: 2, longitude: 49.6, latitude: 55.7 }],
    truncated: false,
    extent: [49.12, 55.7, 50.08, 55.79],
  });
  render(
    <MapPanel
      definition={{ regionCode: 'tatarstan', locality: 'Казань', limit: 1 }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  await waitFor(() => expect(onBounds).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Меток: 0')).toBeTruthy();
  expect(screen.getByText('Загрузка карты…')).toBeTruthy();
  const body = api.mock.calls[0]![2];
  expect(body).toMatchObject({
    regionCode: 'tatarstan',
    locality: 'Казань',
    bounds: [-180, -90, 180, 90],
  });
  const [west, south, east, north] = onBounds.mock.calls[0]![0];
  expect(west).toBeLessThan(49.12);
  expect(east).toBeGreaterThan(50.08);
  expect(south).toBeLessThan(55.7);
  expect(north).toBeGreaterThan(55.79);
});

test('keeps a saved viewport and its polygon when the user moves the map', async () => {
  const onBounds = vi.fn();
  const polygon: [number, number][] = [
    [49, 55],
    [50, 55],
    [50, 56],
    [49, 55],
  ];
  api.mockResolvedValue({ markers: [], truncated: false, extent: null });
  render(
    <MapPanel
      definition={{
        regionCode: 'tatarstan',
        bounds: [48, 54, 51, 57],
        polygon,
      }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(api.mock.calls[0]![2]).toMatchObject({
    bounds: [48, 54, 51, 57],
    polygon,
  });
  fireEvent.click(screen.getByRole('button', { name: 'На восток' }));
  expect(onBounds).toHaveBeenCalledWith([49, 54, 52, 57], polygon);
});

test('keeps a polygon-only search in its original area', async () => {
  const onBounds = vi.fn();
  const polygon: [number, number][] = [
    [49, 55],
    [50, 55],
    [50, 56],
    [49, 55],
  ];
  api.mockResolvedValue({
    markers: [],
    truncated: false,
    extent: [49.5, 55.5, 49.5, 55.5],
  });
  render(
    <MapPanel
      definition={{ polygon }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  await screen.findByText('Меток: 0');
  expect(api.mock.calls[0]![2]).toMatchObject({
    bounds: [49, 55, 50, 56],
    polygon,
  });
  expect(onBounds).not.toHaveBeenCalled();
});

test('an empty regional search explains the absence of map results', async () => {
  const onBounds = vi.fn();
  api.mockResolvedValue({ markers: [], truncated: false, extent: null });
  render(
    <MapPanel
      definition={{ regionCode: 'samara' }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  await screen.findByText('По выбранным условиям на карте нет объявлений.');
  expect(onBounds).not.toHaveBeenCalled();
});

test('an empty known region retains its familiar starting viewport without narrowing the query', async () => {
  api.mockResolvedValue({ markers: [], truncated: false, extent: null });
  render(
    <MapPanel
      definition={{ regionCode: 'adygea' }}
      onBounds={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  await screen.findByText('По выбранным условиям на карте нет объявлений.');
  expect(screen.getByText('Меток: 0').getAttribute('data-bounds')).toBe(
    '38.6,43.7,40.9,45.4',
  );
  expect(api.mock.calls[0]![2].bounds).toEqual([-180, -90, 180, 90]);
});

test('a truncated result never narrows the viewport to the returned subset', async () => {
  const onBounds = vi.fn();
  api.mockResolvedValue({
    markers: [{}],
    truncated: true,
    extent: [49.5, 55.5, 49.5, 55.5],
  });
  render(
    <MapPanel
      definition={{ regionCode: 'tatarstan' }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  await screen.findByText('Приблизьте карту: показана часть результатов.');
  expect(onBounds).not.toHaveBeenCalled();
});

test('an older regional response cannot move a newly selected region', async () => {
  const onBounds = vi.fn();
  let resolvePrevious!: (result: unknown) => void;
  api
    .mockReturnValueOnce(
      new Promise((done) => {
        resolvePrevious = done;
      }),
    )
    .mockResolvedValueOnce({ markers: [], truncated: false, extent: null });
  const view = render(
    <MapPanel
      definition={{ regionCode: 'tatarstan' }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  view.rerender(
    <MapPanel
      definition={{ regionCode: 'samara' }}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  await screen.findByText('По выбранным условиям на карте нет объявлений.');
  await act(async () => {
    resolvePrevious({
      markers: [{}],
      extent: [49, 55, 49, 55],
      truncated: false,
    });
  });
  expect(onBounds).not.toHaveBeenCalled();
});

test('panning or zooming out from the world view keeps a valid search area', async () => {
  const onBounds = vi.fn();
  api.mockResolvedValue({ markers: [{}], truncated: true, extent: null });
  render(<MapPanel definition={{}} onBounds={onBounds} onSelect={vi.fn()} />);
  await screen.findByText('Приблизьте карту: показана часть результатов.');
  for (const name of ['На восток', 'На юг', 'Отдалить']) {
    fireEvent.click(screen.getByRole('button', { name }));
    expect(onBounds).toHaveBeenLastCalledWith([-180, -90, 180, 90], undefined);
  }
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
