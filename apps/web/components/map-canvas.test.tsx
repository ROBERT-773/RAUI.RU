import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import MapCanvas from './map-canvas';

afterEach(cleanup);

test('the search map provides one pair of Russian zoom controls', () => {
  render(
    <MapCanvas
      bounds={[37.61, 55.75, 37.63, 55.77]}
      markers={[]}
      onBounds={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  for (const label of ['Увеличить масштаб', 'Уменьшить масштаб']) {
    expect(
      screen.getByRole('button', { name: label }).getAttribute('title'),
    ).toBe(label);
  }
  expect(screen.queryByRole('button', { name: /Zoom (in|out)/ })).toBeNull();
});
