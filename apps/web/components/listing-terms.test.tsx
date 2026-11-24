import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingTermsFields, { type ListingTerms } from './listing-terms';

afterEach(cleanup);

test('long rentals distinguish missing, included and separately paid utilities', () => {
  const change = vi.fn();
  const fields = (terms: ListingTerms) => (
    <ListingTermsFields deal="long_rent" terms={terms} onChange={change} />
  );
  const { rerender } = render(fields({ deposit: 0 }));
  const select = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Коммунальные платежи',
  });
  expect(select.selectedOptions[0]?.text).toBe('Не указано');

  fireEvent.change(select, { target: { value: 'false' } });
  expect(change).toHaveBeenLastCalledWith({
    deposit: 0,
    utilitiesIncluded: false,
  });
  rerender(fields({ deposit: 0, utilitiesIncluded: false }));
  expect(select.selectedOptions[0]?.text).toBe('Оплачиваются отдельно');

  fireEvent.change(select, { target: { value: 'true' } });
  expect(change).toHaveBeenLastCalledWith({
    deposit: 0,
    utilitiesIncluded: true,
  });
  rerender(fields({ deposit: 0, utilitiesIncluded: true }));
  expect(select.selectedOptions[0]?.text).toBe('Включены');

  fireEvent.change(select, { target: { value: '' } });
  expect(change).toHaveBeenLastCalledWith({ deposit: 0 });
});
