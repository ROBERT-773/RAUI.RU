import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ListingPropertyFields, {
  type PropertyField,
} from './listing-property-fields';

afterEach(cleanup);

test('switching to commercial land excludes floor from submission and preserves its value', () => {
  const propertyFields: PropertyField[] = [
    {
      code: 'commercial_property_type',
      name: 'Тип помещения',
      kind: 'enum',
      required: true,
      options: ['Склад', 'Коммерческая земля'],
    },
    {
      code: 'area',
      name: 'Общая площадь',
      kind: 'number',
      required: true,
      options: [],
    },
    {
      code: 'floor',
      name: 'Этаж',
      kind: 'number',
      required: false,
      options: [],
    },
  ];
  const onCommercialTypeChange = vi.fn();
  const fields = (commercialType: string) => (
    <form>
      <ListingPropertyFields
        category="commercial"
        attributes={{ commercial_property_type: 'Склад', area: 40, floor: 2 }}
        propertyFields={propertyFields}
        commercialType={commercialType}
        dirty
        disabled={false}
        onCommercialTypeChange={onCommercialTypeChange}
      />
    </form>
  );
  const { rerender } = render(fields('Склад'));
  const floor = screen.getByLabelText<HTMLInputElement>('Этаж');
  fireEvent.change(screen.getByLabelText('Тип помещения *'), {
    target: { value: 'Коммерческая земля' },
  });
  expect(onCommercialTypeChange).toHaveBeenCalledWith('Коммерческая земля');
  rerender(fields('Коммерческая земля'));
  expect(screen.getByLabelText('Площадь участка, м² *')).toBeTruthy();
  expect(new FormData(floor.form!).has('floor')).toBe(false);
  rerender(fields('Склад'));
  expect(new FormData(floor.form!).get('floor')).toBe('2');
});
