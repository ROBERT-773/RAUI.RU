import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingModerationActions from './listing-moderation-actions';

afterEach(cleanup);

test('shows only the actions available for the current status', () => {
  const onPreview = vi.fn();
  const onWithdraw = vi.fn();
  const panel = (status: string, disabled = false) => (
    <ListingModerationActions
      status={status}
      previewDisabled={disabled}
      withdrawDisabled={disabled}
      onPreview={onPreview}
      onWithdraw={onWithdraw}
    >
      Предпросмотр
    </ListingModerationActions>
  );
  const { rerender } = render(panel('processing', true));
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Вернуть в черновик' }));
  expect(onPreview).not.toHaveBeenCalled();
  expect(onWithdraw).not.toHaveBeenCalled();

  rerender(panel('draft'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  expect(onPreview).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByText('Предпросмотр')).toBeTruthy();

  rerender(panel('moderation'));
  fireEvent.click(screen.getByRole('button', { name: 'Отозвать с модерации' }));
  expect(onWithdraw).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByText('Предпросмотр')).toBeNull();

  rerender(panel('published'));
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
