export interface PropertyField {
  code: string;
  name: string;
  kind: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  options: string[];
}
import {
  commercialLand,
  listingAttributeFields,
  listingAttributeName,
} from '../lib/listing-attribute-fields';

export default function ListingPropertyFields({
  category,
  attributes,
  propertyFields,
  commercialType,
  dirty,
  disabled,
  onCommercialTypeChange,
}: {
  category: string;
  attributes: Record<string, unknown>;
  propertyFields: PropertyField[];
  commercialType: unknown;
  dirty: boolean;
  disabled: boolean;
  onCommercialTypeChange: (value: string) => void;
}) {
  const isCommercialLand =
    category === 'commercial' && commercialType === commercialLand;
  return (
    <fieldset disabled={disabled}>
      <legend>Характеристики объекта</legend>
      {propertyFields.map((field) => {
        const value = String(attributes[field.code] ?? '');
        const show =
          listingAttributeFields(category, [field], commercialType).length > 0;
        return (
          <label
            key={field.code}
            hidden={!show}
            style={show ? undefined : { display: 'none' }}
          >
            {listingAttributeName(field, isCommercialLand)}
            {field.required ? ' *' : ''}
            {field.kind === 'enum' || field.kind === 'boolean' ? (
              <select
                name={field.code}
                disabled={!show}
                onChange={
                  field.code === 'commercial_property_type'
                    ? (event) => onCommercialTypeChange(event.target.value)
                    : undefined
                }
                required={field.required}
                defaultValue={value}
              >
                <option value="">Не указано</option>
                {field.kind === 'boolean' ? (
                  <>
                    <option value="true">Да</option>
                    <option value="false">Нет</option>
                  </>
                ) : (
                  field.options.map((option) => (
                    <option key={option}>{option}</option>
                  ))
                )}
              </select>
            ) : (
              <input
                name={field.code}
                disabled={!show}
                required={field.required}
                type={field.kind === 'number' ? 'number' : 'text'}
                step={field.kind === 'number' ? 'any' : undefined}
                min={
                  ['area', 'land_area'].includes(field.code)
                    ? 0.01
                    : field.code === 'kitchen_area'
                      ? 0
                      : undefined
                }
                maxLength={field.kind === 'string' ? 2000 : undefined}
                defaultValue={value}
              />
            )}
            {field.code === 'kitchen_area' && (
              <small>Укажите 0, если отдельной кухни нет.</small>
            )}
          </label>
        );
      })}
      <button>Сохранить характеристики</button>
      {dirty && <button type="reset">Отменить правки характеристик</button>}
    </fieldset>
  );
}
