import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import L from 'leaflet';
import MapCanvas from './map-canvas';

afterEach(cleanup);

test('focusing and selecting a price never starts a map pan before the next arrow key', () => {
  const panInside = vi.spyOn(L.Map.prototype, 'panInside');
  const panBy = vi.spyOn(L.Map.prototype, 'panBy').mockReturnThis();
  try {
    const onSelect = vi.fn();
    const { container } = render(
      <MapCanvas
        bounds={[37.598, 55.742, 37.712, 55.808]}
        markers={[
          {
            id: 'flat',
            count: 1,
            latitude: 55.75,
            longitude: 37.61,
            minPrice: 10000000,
            listingIds: ['flat'],
          },
        ]}
        onBounds={vi.fn()}
        onSelect={onSelect}
      />,
    );
    const marker = container.querySelector<HTMLElement>('.price-marker')!;
    marker.focus();
    fireEvent.keyDown(marker, { key: 'Enter', keyCode: 13 });
    expect(onSelect).toHaveBeenCalledWith(['flat']);
    expect(panInside).not.toHaveBeenCalled();
    const map = container.querySelector<HTMLElement>('.leaflet-map')!;
    map.focus();
    fireEvent.keyDown(map, { key: 'ArrowRight', keyCode: 39 });
    expect(panBy).toHaveBeenCalledWith([80, 0]);
  } finally {
    panInside.mockRestore();
    panBy.mockRestore();
  }
});

test('the search map provides one pair of Russian zoom controls', () => {
  const onBounds = vi.fn();
  render(
    <MapCanvas
      bounds={[37.61, 55.75, 37.63, 55.77]}
      markers={[]}
      onBounds={onBounds}
      onSelect={vi.fn()}
    />,
  );
  for (const label of ['Увеличить масштаб', 'Уменьшить масштаб']) {
    expect(
      screen.getByRole('button', { name: label }).getAttribute('title'),
    ).toBe(label);
  }
  expect(screen.queryByRole('button', { name: /Zoom (in|out)/ })).toBeNull();
  expect(onBounds).not.toHaveBeenCalled();
});
