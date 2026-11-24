import { useId } from 'react';

export type ListingTerms = Record<string, string | number | boolean>;

export default function ListingTermsFields({
  deal,
  terms,
  onChange,
}: {
  deal: string;
  terms: ListingTerms;
  onChange: (terms: ListingTerms) => void;
}) {
  const dateErrorId = useId();
  const dateError =
    typeof terms.availableFrom === 'string' &&
    typeof terms.availableUntil === 'string' &&
    terms.availableFrom !== '' &&
    terms.availableUntil !== '' &&
    terms.availableUntil <= terms.availableFrom
      ? 'Выберите дату выезда позже даты заезда.'
      : '';
  const set = (key: string, value: string | number | boolean) => {
    const next = { ...terms };
    if (value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };

  if (deal === 'sale') {
    return (
      <label className="listing-option">
        <input
          type="checkbox"
          checked={terms.negotiable === true}
          onChange={(event) => set('negotiable', event.target.checked)}
        />
        Возможен торг
      </label>
    );
  }
  return (
    <>
      <label>
        Залог, ₽
        <input
          type="number"
          min={0}
          max={999999999}
          value={String(terms.deposit ?? '')}
          onChange={(event) =>
            set(
              'deposit',
              event.target.value === '' ? '' : event.target.valueAsNumber,
            )
          }
        />
      </label>
      {deal === 'long_rent' ? (
        <>
          <label>
            Комиссия, %
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={String(terms.commission ?? '')}
              onChange={(event) =>
                set(
                  'commission',
                  event.target.value === '' ? '' : event.target.valueAsNumber,
                )
              }
            />
          </label>
          <label>
            Коммунальные платежи
            <select
              value={
                typeof terms.utilitiesIncluded === 'boolean'
                  ? String(terms.utilitiesIncluded)
                  : ''
              }
              onChange={(event) => {
                const value = event.target.value;
                set('utilitiesIncluded', value === '' ? '' : value === 'true');
              }}
            >
              <option value="">Не указано</option>
              <option value="true">Включены</option>
              <option value="false">Оплачиваются отдельно</option>
            </select>
          </label>
        </>
      ) : (
        <>
          <label>
            Минимум ночей
            <input
              type="number"
              min={1}
              max={365}
              value={String(terms.minimumNights ?? '')}
              onChange={(event) =>
                set(
                  'minimumNights',
                  event.target.value === '' ? '' : event.target.valueAsNumber,
                )
              }
            />
          </label>
          <label>
            Максимум гостей
            <input
              type="number"
              min={1}
              max={9999}
              step={1}
              value={String(terms.guestCapacity ?? '')}
              onChange={(event) =>
                set(
                  'guestCapacity',
                  event.target.value === '' ? '' : event.target.valueAsNumber,
                )
              }
            />
          </label>
          <label>
            Доступно с
            <input
              type="date"
              required={Boolean(terms.availableUntil)}
              value={String(terms.availableFrom ?? '')}
              onChange={(event) => set('availableFrom', event.target.value)}
            />
          </label>
          <label>
            Доступно до (дата выезда)
            <input
              type="date"
              required={Boolean(terms.availableFrom)}
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? dateErrorId : undefined}
              ref={(input) => {
                input?.setCustomValidity(dateError);
              }}
              value={String(terms.availableUntil ?? '')}
              onChange={(event) => set('availableUntil', event.target.value)}
            />
          </label>
          {dateError && <p id={dateErrorId}>{dateError}</p>}
        </>
      )}
    </>
  );
}
