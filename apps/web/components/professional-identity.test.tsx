import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ListingAuthors, ProfessionalIdentity } from './professional-identity';

afterEach(cleanup);
test('links public profiles by their display names and shows their own versioned images in the supplied order', () => {
  render(
    <ListingAuthors
      profiles={[
        {
          kind: 'agency',
          name: 'Агентство Восток',
          id: 'company',
          imageId: 'logo',
        },
        {
          kind: 'agent',
          name: 'Анна Котова',
          id: 'person',
          imageId: 'portrait',
        },
      ]}
      sellerType="agency"
    />,
  );
  const card = screen.getByRole('region', { name: 'Кто разместил объявление' });
  const links = within(card).getAllByRole('link');
  expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
    ['Агентство Восток', '/professionals/company'],
    ['Анна Котова', '/professionals/person'],
  ]);
  expect(
    within(card).getByAltText('Логотип агентства').getAttribute('src'),
  ).toBe('/api/v1/search/professionals/company/image/logo');
  expect(within(card).getByAltText('Фото агента').getAttribute('src')).toBe(
    '/api/v1/search/professionals/person/image/portrait',
  );
});
test('shows only the neutral seller role for an unlisted author and omits a missing portrait', () => {
  const view = render(<ListingAuthors profiles={[]} sellerType="owner" />);
  expect(screen.getByText('Собственник')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
  view.rerender(
    <ProfessionalIdentity
      profile={{
        kind: 'agent',
        id: 'person',
        name: 'Анна Котова',
        imageId: null,
      }}
      heading
    />,
  );
  expect(
    screen.getByRole('heading', { level: 1, name: 'Анна Котова' }),
  ).toBeTruthy();
  expect(screen.getByText('Агент по недвижимости')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});
