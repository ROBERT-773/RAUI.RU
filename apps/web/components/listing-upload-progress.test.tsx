import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingUploadProgress from './listing-upload-progress';

afterEach(cleanup);

test('shows the stopped file and offers retry or cancellation after loading ends', () => {
  const props = {
    progress: {
      total: 3,
      remaining: 2,
      kind: 'photo' as const,
      filename: 'second.png',
    },
    onRetry: vi.fn(),
    onCancel: vi.fn(),
  };
  const { rerender } = render(
    <ListingUploadProgress {...props} busy disabled />,
  );
  const retry = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Повторить загрузку фотографии',
  });
  const cancel = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Отменить загрузку оставшихся файлов',
  });
  expect(retry.disabled).toBe(true);
  expect(cancel.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).not.toContain('second.png');
  rerender(<ListingUploadProgress {...props} busy={false} disabled={false} />);
  expect(screen.getByRole('status').textContent).toMatch(
    /Принято файлов 1 из 3.*second\.png/,
  );
  fireEvent.click(retry);
  fireEvent.click(cancel);
  expect(props.onRetry).toHaveBeenCalledOnce();
  expect(props.onCancel).toHaveBeenCalledOnce();
});
