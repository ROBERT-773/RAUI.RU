import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingMediaGallery from './listing-media-gallery';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('only removable files emit a deletion after confirmation', () => {
  const photo = { id: 'failed', kind: 'photo', state: 'failed' };
  const onRemove = vi.fn();
  const confirm = vi
    .spyOn(window, 'confirm')
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  render(
    <ListingMediaGallery
      media={[photo, { id: 'queued', kind: 'photo', state: 'queued' }]}
      photoCount={2}
      refreshNeeded={false}
      editable
      removalDisabled={false}
      onRemove={onRemove}
    />,
  );
  expect(screen.getByText('Фотография обрабатывается')).toBeTruthy();
  const remove = screen.getByRole('button', { name: 'Удалить фото с ошибкой' });
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(remove);
  expect(onRemove).not.toHaveBeenCalled();
  fireEvent.click(remove);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(onRemove).toHaveBeenCalledWith(photo);
});
