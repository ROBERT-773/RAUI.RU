import { expect, test } from 'vitest';
import {
  commercialLand,
  listingAttributeFields,
} from './listing-attribute-fields';

test('automatic gates are relevant to warehouses and production', () => {
  const fields = [{ code: 'automatic_gates', required: false }];
  expect(listingAttributeFields('commercial', fields, 'Склад')).toEqual(fields);
  expect(listingAttributeFields('commercial', fields, 'Производство')).toEqual(
    fields,
  );
  expect(listingAttributeFields('commercial', fields, 'Офис')).toEqual([]);
});

test('commercial listings retain commercial characteristics and omit optional housing fields', () => {
  const fields = [
    { code: 'area', required: true },
    { code: 'commercial_property_type', required: true },
    { code: 'commercial_building_class', required: false },
    { code: 'rooms', required: false },
    { code: 'balcony', required: false },
  ];
  expect(listingAttributeFields('commercial', fields)).toEqual(
    fields.slice(0, 3),
  );
  expect(listingAttributeFields('apartment', fields)).toEqual(fields);
});

test('commercial land keeps the subtype and area without building fields', () => {
  const fields = [
    { code: 'area', required: true },
    { code: 'commercial_property_type', required: true },
    { code: 'floor', required: false },
    { code: 'commercial_finish', required: false },
  ];
  expect(listingAttributeFields('commercial', fields, commercialLand)).toEqual(
    fields.slice(0, 2),
  );
  expect(listingAttributeFields('commercial', fields, 'Офис')).toEqual(fields);
});
