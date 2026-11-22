import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import SavedListingPreview from './saved-listing-preview';

afterEach(cleanup);

test('previews saved fields and excludes photos that are still processing', () => {
  const { container } = render(
    <SavedListingPreview
      listing={{
        title: 'Квартира у парка',
        deal_type: 'sale',
        price: '5000000',
        description: 'Сохранённое описание',
      }}
      property={{
        category_code: 'apartment',
        attributes: {},
        address: { formatted: 'Москва, улица 1' },
      }}
      propertyFields={[]}
      media={[
        { id: 'pending', kind: 'photo', state: 'processing' },
        { id: 'plan', kind: 'floor_plan', state: 'ready' },
        { id: 'photo', kind: 'photo', state: 'ready' },
      ]}
    />,
  );
  container.querySelector('details')!.open = true;
  expect(screen.getByText('Сохранённое описание')).toBeTruthy();
  expect(screen.getByText('Москва, улица 1')).toBeTruthy();
  expect(
    screen.getAllByRole('img').map((image) => image.getAttribute('src')),
  ).toEqual(['/api/v1/media/photo/small', '/api/v1/media/plan/small']);
});
