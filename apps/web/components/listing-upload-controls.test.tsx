import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingUploadControls from './listing-upload-controls';

afterEach(cleanup);

test('photo limit blocks photo drops but still accepts a floor plan', () => {
  const onFiles = vi.fn();
  render(
    <ListingUploadControls blocked={false} photoCount={21} onFiles={onFiles} />,
  );
  const photo = screen.getByLabelText<HTMLInputElement>('Добавить фотографию');
  const plan = screen.getByLabelText<HTMLInputElement>('Добавить планировку');
  const file = new File(['image'], 'plan.png', { type: 'image/png' });
  expect(photo.disabled).toBe(true);
  expect(plan.disabled).toBe(false);
  expect(plan.multiple).toBe(false);
  fireEvent.drop(screen.getByRole('group', { name: 'Загрузка фотографий' }), {
    dataTransfer: { files: [file] },
  });
  expect(onFiles).not.toHaveBeenCalled();
  fireEvent.change(plan, { target: { files: [file] } });
  expect(onFiles).toHaveBeenCalledWith('floor_plan', [file]);
});
