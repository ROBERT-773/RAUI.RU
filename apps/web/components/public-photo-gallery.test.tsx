import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import PublicPhotoGallery from './public-photo-gallery';

afterEach(cleanup);

const photos = ['first', 'second', 'third'].map((id) => ({
  src: '/api/v1/media/' + id + '/large',
  width: 960,
  height: 720,
}));

test('photos follow the feed order, with keyboard and button navigation', async () => {
  const user = userEvent.setup();
  render(<PublicPhotoGallery photos={photos} />);
  const image = screen.getByRole('img', { name: 'Фото недвижимости' });
  expect(image.getAttribute('src')).toBe(photos[0]!.src);
  await user.click(screen.getByRole('button', { name: 'Следующее фото' }));
  expect(image.getAttribute('src')).toBe(photos[1]!.src);
  expect(screen.getByText('2 из 3')).toBeTruthy();
  await user.keyboard('{ArrowLeft}');
  await user.click(screen.getByRole('button', { name: 'Предыдущее фото' }));
  expect(image.getAttribute('src')).toBe(photos[2]!.src);
});

test('single photo and empty listings only show applicable controls', () => {
  const { rerender } = render(<PublicPhotoGallery photos={[]} />);
  expect(screen.queryByRole('region')).toBeNull();
  rerender(<PublicPhotoGallery photos={photos.slice(0, 1)} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe(photos[0]!.src);
  expect(screen.queryByRole('button')).toBeNull();
});

test('a horizontal swipe changes the photo and vertical scrolling keeps it', () => {
  render(<PublicPhotoGallery photos={photos} />);
  const image = screen.getByRole('img');
  for (const [x, y] of [
    [77, 160],
    [20, 84],
  ]) {
    fireEvent.touchStart(image, { touches: [{ clientX: 95, clientY: 80 }] });
    fireEvent.touchEnd(image, { changedTouches: [{ clientX: x, clientY: y }] });
  }
  expect(image.getAttribute('src')).toBe(photos[1]!.src);
});
