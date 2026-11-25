import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { SearchDefinition } from '@raui/types/product';
import Page from './page';

vi.mock('../../components/search', () => ({
  default: ({ initialDefinition }: { initialDefinition: SearchDefinition }) => (
    <output>{JSON.stringify(initialDefinition)}</output>
  ),
}));

test.each([
  [
    { deal: 'sale', region: 'tatarstan' },
    { dealType: 'sale', regionCode: 'tatarstan' },
  ],
  [
    { deal: 'long_rent', budget: '50000' },
    { dealType: 'long_rent', price: { max: 50000 } },
  ],
  [
    { deal: 'short_rent', city: 'moscow' },
    { dealType: 'short_rent', locality: 'Москва' },
  ],
  [
    { deal: 'sale', region: 'tatarstan', q: ' Казань ' },
    { dealType: 'sale', regionCode: 'tatarstan', q: 'Казань' },
  ],
  [{ deal: 'unknown' }, {}],
])(
  'keeps the geographic scope explicitly supplied by the search link %j',
  async (params, expected) => {
    const { unmount } = render(
      await Page({ searchParams: Promise.resolve(params) }),
    );
    try {
      expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toEqual({
        limit: 20,
        ...expected,
      });
    } finally {
      unmount();
    }
  },
);
