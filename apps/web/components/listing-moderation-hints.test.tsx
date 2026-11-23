import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ListingModerationHints from './listing-moderation-hints';

afterEach(cleanup);

test('shows actionable blockers and clears them when the draft is ready', () => {
  const { rerender, container } = render(
    <ListingModerationHints
      photosReady={false}
      readyPhotos={4}
      hasUnsavedChanges
      offerError="Укажите цену больше нуля."
      descriptionTooShort
      missingFieldNames={['Площадь кухни', 'Этаж']}
    />,
  );
  expect(screen.getByText(/Сейчас готово: 4/)).toBeTruthy();
  expect(screen.getByText('Сохраните изменения перед отправкой.')).toBeTruthy();
  expect(screen.getByText('Укажите цену больше нуля.')).toBeTruthy();
  expect(screen.getByText(/не менее 15 символов/)).toBeTruthy();
  expect(screen.getByText(/Площадь кухни; Этаж/)).toBeTruthy();
  rerender(
    <ListingModerationHints
      photosReady
      readyPhotos={5}
      hasUnsavedChanges={false}
      offerError={undefined}
      descriptionTooShort={false}
      missingFieldNames={[]}
    />,
  );
  expect(container.textContent).toBe('');
});
