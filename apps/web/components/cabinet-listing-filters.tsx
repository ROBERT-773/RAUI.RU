import { listingStates } from './listing-editor-status';

export default function CabinetListingFilters({
  filters,
  disabled,
  onSearch,
}: {
  filters: string;
  disabled: boolean;
  onSearch: (filters: string) => void;
}) {
  const current = new URLSearchParams(filters);
  return (
    <form
      aria-label="Фильтры моих объявлений"
      onSubmit={(event) => {
        event.preventDefault();
        const query = new URLSearchParams();
        for (const [key, value] of new FormData(event.currentTarget)) {
          if (typeof value === 'string' && value.trim())
            query.set(key, value.trim());
        }
        onSearch(query.toString());
      }}
    >
      <fieldset disabled={disabled} className="actions">
        <legend>Поиск по моим объявлениям</legend>
        <label>
          Адрес, название или номер объявления
          <input
            name="q"
            type="search"
            maxLength={200}
            defaultValue={current.get('q') ?? ''}
          />
        </label>
        <label>
          Фильтр по сделке
          <select name="deal" defaultValue={current.get('deal') ?? ''}>
            <option value="">Все сделки</option>
            <option value="sale">Продажа</option>
            <option value="rent">Аренда</option>
          </select>
        </label>
        <label>
          Фильтр по статусу
          <select name="status" defaultValue={current.get('status') ?? ''}>
            <option value="">Все статусы</option>
            {Object.entries(listingStates).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Найти объявления</button>
        {filters && (
          <button type="button" onClick={() => onSearch('')}>
            Сбросить фильтры
          </button>
        )}
      </fieldset>
    </form>
  );
}
