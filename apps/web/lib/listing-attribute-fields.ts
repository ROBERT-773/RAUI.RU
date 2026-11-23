const landFields = new Set([
  'area',
  'land_status',
  'mortgage',
  'metro',
  'okrug',
  'highway',
  'highway_distance',
]);
const residentialFields = new Set([
  'rooms',
  'bathroom',
  'balcony',
  'loggia',
  'furniture',
  'market',
  'living_area',
  'kitchen_area',
]);

const commercialLandFields = new Set([
  ...landFields,
  'commercial_property_type',
]);
export const commercialLand = 'Коммерческая земля';

export function listingAttributeName(
  field: { code: string; name: string },
  isCommercialLand: boolean,
) {
  return isCommercialLand && field.code === 'area'
    ? 'Площадь участка, м²'
    : field.name;
}

export function listingAreaError(
  fields: readonly { code: string; name: string }[],
  attributes: Record<string, unknown>,
  isCommercialLand: boolean,
) {
  const field = fields.find(({ code }) => {
    if (code !== 'area' && code !== 'land_area') return false;
    const value = attributes[code];
    return (
      (typeof value === 'number' ||
        (typeof value === 'string' && value !== '')) &&
      Number(value) <= 0
    );
  });
  if (!field) return;
  return `Укажите значение больше нуля в поле «${listingAttributeName(field, isCommercialLand)}».`;
}

export function listingAttributeFields<
  T extends { code: string; required: boolean },
>(category: string, fields: T[], commercialType?: unknown): T[] {
  if (category === 'land')
    return fields.filter(
      (field) => field.required || landFields.has(field.code),
    );
  if (category === 'commercial' && commercialType === commercialLand)
    return fields.filter(
      (field) => field.required || commercialLandFields.has(field.code),
    );
  if (category === 'commercial')
    return fields.filter(
      (field) =>
        field.required ||
        (!residentialFields.has(field.code) &&
          (field.code !== 'automatic_gates' ||
            commercialType === 'Склад' ||
            commercialType === 'Производство')),
    );
  return fields;
}
