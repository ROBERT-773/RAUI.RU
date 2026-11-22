import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingOfferFields from './listing-offer-fields';

afterEach(cleanup);

test('short rental fields show daily pricing and delegate changes and reset', () => {
  const onPriceChange = vi.fn();
  const onReset = vi.fn();
  render(
    <ListingOfferFields
      deal="short_rent"
      title="Квартира"
      price="5000"
      description="  Текст  "
      terms={{}}
      dirty
      disabled={false}
      onTitleChange={vi.fn()}
      onPriceChange={onPriceChange}
      onDescriptionChange={vi.fn()}
      onTermsChange={vi.fn()}
      onReset={onReset}
    />,
  );
  fireEvent.change(screen.getByLabelText('Цена, ₽ за сутки'), {
    target: { value: '5500' },
  });
  expect(onPriceChange).toHaveBeenCalledWith('5500');
  expect(screen.getByText(/Символов в описании: 5/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Отменить несохранённые изменения' }),
  );
  expect(onReset).toHaveBeenCalledOnce();
});
