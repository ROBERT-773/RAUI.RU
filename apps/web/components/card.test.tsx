import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { Card } from './card';
import { track } from '../lib/client';

vi.mock('../lib/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/client')>()),
  track: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listing = {
  id: 'flat-17',
  title: 'Квартира у парка',
  price: 9_999_999,
  deal_type: 'sale',
  address: 'Москва, улица Лесная, 17',
  attributes: { area: '50.5', rooms: 2, floor: '4', floors: 12 },
  media: [{ id: 'photo', url: '/v1/media/photo/small' }],
};

test.each(['map', 'list'] as const)(
  'cover and title share one %s result link and one tracking event per click',
  async (mode) => {
    const action = vi.fn();
    const context = { definition: JSON.stringify({ q: 'Парк & пруд' }), mode };
    const user = userEvent.setup();
    render(
      <div onClick={(event) => event.preventDefault()}>
        <Card
          listing={listing}
          searchContext={context}
          actions={<button onClick={action}>В избранное</button>}
        />
      </div>,
    );
    const article = screen.getByRole('article');
    const link = within(article).getByRole('link', { name: listing.title });
    const title = within(link).getByText(listing.title);
    const image = article.querySelector('img')!;
    expect(image.closest('a')).toBe(link);
    expect(
      screen.getByRole('heading', { name: listing.title }).contains(link),
    ).toBe(true);
    expect(within(article).getAllByRole('link')).toHaveLength(1);
    const url = new URL(link.getAttribute('href')!, 'https://example.test');
    expect(url.pathname).toBe('/listings/flat-17');
    expect(Object.fromEntries(url.searchParams)).toEqual(context);

    fireEvent.click(image);
    expect(track).toHaveBeenCalledExactlyOnceWith({
      type: 'result_viewed',
      listingId: listing.id,
    });
    fireEvent.click(title);
    expect(track).toHaveBeenCalledTimes(2);
    const favorite = within(article).getByRole('button', {
      name: 'В избранное',
    });
    expect(favorite.closest('a')).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(link);
    await user.tab();
    expect(document.activeElement).toBe(favorite);
    await user.keyboard('{Enter}');
    expect(action).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(2);
  },
);

test('formats valid sale facts and keeps the photo placeholder out of the link name', () => {
  render(<Card listing={{ ...listing, media: [] }} />);
  const link = screen.getByRole('link', { name: listing.title });
  expect(link.getAttribute('href')).toBe('/listings/flat-17');
  expect(screen.getByText('Фото пока нет').closest('a')).toBe(link);
  expect(screen.getByText('50,5 м² · 2 комн. · 4/12 этаж')).toBeTruthy();
  expect(screen.getByText(/198\s020\s₽\/м²/)).toBeTruthy();
});

test.each([
  ['long_rent', '/ мес.'],
  ['short_rent', '/ сутки'],
])('keeps the rental price period for %s', (deal, period) => {
  const { container } = render(
    <Card listing={{ ...listing, deal_type: deal }} />,
  );
  expect(container.querySelector('.price')?.textContent).toContain(period);
  expect(container.textContent).not.toContain('₽/м²');
});

test('displays a studio, a zero floor and a basement without inventing a storey count', () => {
  const { rerender } = render(
    <Card listing={{ ...listing, attributes: { rooms: 0, floor: 0 } }} />,
  );
  expect(screen.getByText('Студия · 0 этаж')).toBeTruthy();
  rerender(
    <Card listing={{ ...listing, attributes: { floor: -1, floors: 5 } }} />,
  );
  expect(screen.getByText('-1/5 этаж')).toBeTruthy();
  rerender(<Card listing={{ ...listing, attributes: { floors: 5 } }} />);
  expect(screen.getByText('Этажей в доме — 5')).toBeTruthy();
});

test.each([
  {},
  { area: 0, rooms: -1, floor: 8, floors: 3 },
  { area: ' ', rooms: false, floor: '', floors: NaN },
  { area: Infinity, rooms: {}, floor: 1.5, floors: 'пять' },
])(
  'omits missing or contradictory facts and undefined unit prices',
  (attributes) => {
    const { container } = render(<Card listing={{ ...listing, attributes }} />);
    expect(container.textContent).not.toMatch(/м²|комн\.|этаж|NaN|Infinity|—/i);
  },
);

test('does not present a zero sale price as a price per square metre', () => {
  const { container } = render(<Card listing={{ ...listing, price: 0 }} />);
  expect(container.textContent).not.toMatch(/₽\/м²|NaN|Infinity/);
});
