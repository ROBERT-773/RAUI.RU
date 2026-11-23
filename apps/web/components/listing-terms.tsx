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
          <label className="listing-option">
            <input
              type="checkbox"
              checked={terms.utilitiesIncluded === true}
              onChange={(event) =>
                set('utilitiesIncluded', event.target.checked)
              }
            />
            Коммунальные платежи включены
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
              value={String(terms.availableUntil ?? '')}
              onChange={(event) => set('availableUntil', event.target.value)}
            />
          </label>
        </>
      )}
    </>
  );
}
