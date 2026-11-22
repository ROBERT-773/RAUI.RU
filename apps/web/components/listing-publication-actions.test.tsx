import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingPublicationActions from './listing-publication-actions';

afterEach(cleanup);

test('shows publication actions by status and blocks archive with unsaved changes', () => {
  const onPause = vi.fn();
  const onArchive = vi.fn();
  const actions = (status: string, hasUnsavedChanges = false) => (
    <ListingPublicationActions
      listingId="example"
      status={status}
      disabled={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onPause={onPause}
      onArchive={onArchive}
    />
  );
  const { rerender } = render(actions('published'));
  expect(screen.getByRole('link').getAttribute('href')).toBe(
    '/listings/example',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Приостановить' }));
  expect(onPause).toHaveBeenCalledOnce();

  rerender(actions('paused', true));
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Приостановить' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'В архив' }));
  expect(onArchive).not.toHaveBeenCalled();

  rerender(actions('paused'));
  fireEvent.click(screen.getByRole('button', { name: 'В архив' }));
  expect(onArchive).toHaveBeenCalledOnce();

  rerender(actions('archived'));
  expect(screen.queryByRole('button')).toBeNull();
});
