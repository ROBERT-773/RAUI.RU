import ListingTermsFields, { type ListingTerms } from './listing-terms';

export default function ListingOfferFields({
  deal,
  title,
  price,
  description,
  terms,
  dirty,
  disabled,
  onTitleChange,
  onPriceChange,
  onDescriptionChange,
  onTermsChange,
  onReset,
}: {
  deal: string;
  title: string;
  price: string;
  description: string;
  terms: ListingTerms;
  dirty: boolean;
  disabled: boolean;
  onTitleChange: (value: string) => void;
  onPriceChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onTermsChange: (value: ListingTerms) => void;
  onReset: () => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Условия предложения</legend>
      <label>
        Название
        <input
          required
          minLength={3}
          maxLength={200}
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </label>
      <label>
        {deal === 'long_rent'
          ? 'Цена, ₽ в месяц'
          : deal === 'short_rent'
            ? 'Цена, ₽ за сутки'
            : 'Цена, ₽'}
        <input
          required
          type="number"
          min="0.01"
          max="99999999999999"
          step="0.01"
          value={price}
          onChange={(e) => onPriceChange(e.target.value)}
        />
      </label>
      <label>
        Описание
        <textarea
          maxLength={10000}
          aria-describedby="listing-description-length"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
      </label>
      <small id="listing-description-length">
        Символов в описании: {description.trim().length}. Для отправки нужно не
        менее 15.
      </small>
      <ListingTermsFields deal={deal} terms={terms} onChange={onTermsChange} />
      <button type="submit">Сохранить изменения</button>
      {dirty && (
        <button type="button" onClick={onReset}>
          Отменить несохранённые изменения
        </button>
      )}
    </fieldset>
  );
}
