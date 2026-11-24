import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import ListingLocationMap from './listing-location-map';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const point = { latitude: 55.76123456, longitude: 37.62123456 };
const buttonName = 'Показать объект на карте';
const externalMap = 'Открыть в Яндекс Картах';
const unavailable =
  'Фон карты недоступен. Местоположение указано координатами.';

test('opens the exact listing position on demand without a tile provider', async () => {
  vi.stubEnv('NEXT_PUBLIC_MAP_TILE_URL', '');
  const { default: L } = await import('leaflet');
  const markerAdded = vi.spyOn(L.Marker.prototype, 'onAdd');
  const user = userEvent.setup();
  const { container } = render(<ListingLocationMap {...point} />);
  const toggle = screen.getByRole('button', { name: buttonName });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('link', { name: externalMap })).toBeNull();
  expect(container.querySelector('.leaflet-container')).toBeNull();
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('region', { name: 'Карта объекта' })).toBeTruthy();
  expect(
    await screen.findByRole('img', { name: 'Метка объекта' }),
  ).toBeTruthy();
  const marker = markerAdded.mock.instances[0];
  if (!(marker instanceof L.Marker)) throw new Error('Missing Leaflet marker');
  expect(marker.getLatLng()).toMatchObject({
    lat: point.latitude,
    lng: point.longitude,
  });
  expect(markerAdded.mock.calls[0]?.[0].getCenter()).toMatchObject({
    lat: point.latitude,
    lng: point.longitude,
  });
  expect(
    screen.getByText('Широта 55.76123456, долгота 37.62123456'),
  ).toBeTruthy();
  expect(screen.getByText(unavailable)).toBeTruthy();
  for (const label of ['Увеличить масштаб', 'Уменьшить масштаб']) {
    expect(
      screen.getByRole('button', { name: label }).getAttribute('title'),
    ).toBe(label);
  }
  const link = screen.getByRole('link', {
    name: externalMap,
  }) as HTMLAnchorElement;
  const url = new URL(link.href);
  expect([url.origin, url.pathname, url.searchParams.get('text')]).toEqual([
    'https://yandex.ru',
    '/maps/',
    '55.76123456,37.62123456',
  ]);
  expect(link.target).toBe('_blank');
  expect(link.relList.contains('noopener')).toBe(true);
  expect(link.relList.contains('noreferrer')).toBe(true);
  await user.click(toggle);
  expect(screen.queryByRole('region', { name: 'Карта объекта' })).toBeNull();
});

test('requests configured tiles only after opening and keeps the marker and coordinates when tiles fail', async () => {
  vi.stubEnv('NEXT_PUBLIC_MAP_TILE_URL', '/tiles/{z}/{x}/{y}.png');
  const user = userEvent.setup();
  const { container } = render(
    <ListingLocationMap {...point} longitude={-179.125} />,
  );
  expect(container.querySelector('img.leaflet-tile')).toBeNull();
  await user.click(screen.getByRole('button', { name: buttonName }));
  const marker = await screen.findByRole('img', { name: 'Метка объекта' });
  await waitFor(() =>
    expect(container.querySelector('img.leaflet-tile')).toBeTruthy(),
  );
  expect(screen.queryByRole('link', { name: externalMap })).toBeNull();
  fireEvent.error(container.querySelector('img.leaflet-tile')!);
  expect(await screen.findByText(unavailable)).toBeTruthy();
  expect(marker.isConnected).toBe(true);
  expect(screen.getByText('Широта 55.76123456, долгота -179.125')).toBeTruthy();
  const link = screen.getByRole('link', {
    name: externalMap,
  }) as HTMLAnchorElement;
  expect(new URL(link.href).searchParams.get('text')).toBe(
    '55.76123456,-179.125',
  );
});
