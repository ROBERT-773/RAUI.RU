import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ListingEditorStatus from './listing-editor-status';

afterEach(cleanup);

test('shows the moderation reason only for a rejected listing', () => {
  const props = {
    representation: 'От организации',
    rejectionReason: 'Уточните описание',
  };
  const { rerender } = render(
    <ListingEditorStatus status="rejected" {...props} />,
  );
  expect(screen.getByText('Статус: Отклонено')).toBeTruthy();
  expect(screen.getByText('От организации')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(
    'Причина отклонения: Уточните описание',
  );
  rerender(<ListingEditorStatus status="draft" {...props} />);
  expect(screen.getByText('Статус: Черновик')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});
