import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SavedListingsList from './saved-listings-list';

afterEach(cleanup);

test('retries a failed load and opens a saved listing only when enabled', () => {
  const onRetry = vi.fn();
  const onOpen = vi.fn();
  const onLoadMore = vi.fn();
  const list = (loadFailed: boolean, openDisabled: boolean) => (
    <SavedListingsList
      items={loadFailed ? [] : [{ id: 'draft', title: '', status: 'draft' }]}
      loadFailed={loadFailed}
      checking={false}
      more={!loadFailed}
      retryDisabled={false}
      openDisabled={openDisabled}
      loadMoreDisabled={false}
      onRetry={onRetry}
      onOpen={onOpen}
      onLoadMore={onLoadMore}
    />
  );
  const { rerender } = render(list(true, false));
  expect(screen.getByRole('status').textContent).toContain(
    'Не удалось загрузить',
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Повторить загрузку объявлений' }),
  );
  expect(onRetry).toHaveBeenCalledOnce();

  rerender(list(false, true));
  fireEvent.click(screen.getByRole('button', { name: 'Без названия' }));
  expect(onOpen).not.toHaveBeenCalled();

  rerender(list(false, false));
  fireEvent.click(screen.getByRole('button', { name: 'Без названия' }));
  expect(onOpen).toHaveBeenCalledWith('draft');
  fireEvent.click(
    screen.getByRole('button', { name: 'Показать ещё объявления' }),
  );
  expect(onLoadMore).toHaveBeenCalledOnce();
});
