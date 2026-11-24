import type { ListingTerms } from './listing-terms';

export type ListingForm = {
  step: number;
  category: string;
  deal: string;
  region: string;
  organizationId: string;
  locality: string;
  address: string;
  longitude: string;
  latitude: string;
  coordinatesFromSuggestion?: boolean;
  attributes: Record<string, string>;
  title: string;
  price: string;
  terms: ListingTerms;
};

export type AccountListingDraft = {
  id: string;
  version: number;
  form: ListingForm;
};

function sameFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => right[key] === value)
  );
}

export function sameListingForm(a: ListingForm, b: ListingForm) {
  const { attributes, terms, ...fields } = a;
  const { attributes: otherAttributes, terms: otherTerms, ...otherFields } = b;
  return (
    sameFields(fields, otherFields) &&
    sameFields(attributes, otherAttributes) &&
    sameFields(terms, otherTerms)
  );
}

export function ListingFormDrafts({
  drafts,
  categories,
  steps,
  failed,
  disabled,
  onResume,
  onRetry,
}: {
  drafts: AccountListingDraft[];
  categories: { code: string; name: string }[];
  steps: string[];
  failed: boolean;
  disabled: boolean;
  onResume: (draft: AccountListingDraft) => void;
  onRetry: () => void;
}) {
  if (!drafts.length && !failed) return null;
  return (
    <section aria-label="Незавершённые объявления">
      <h3>Незавершённые объявления</h3>
      {failed && (
        <p>
          Не удалось загрузить сохранённые формы.{' '}
          <button type="button" disabled={disabled} onClick={onRetry}>
            Обновить черновики
          </button>
        </p>
      )}
      {drafts.length > 0 && (
        <ul>
          {drafts.map((draft, i) => {
            const { id, form } = draft;
            const categoryName = categories.find(
              ({ code }) => code === form.category,
            )?.name;
            const name =
              form.title.trim() ||
              [categoryName, form.address.trim() || form.locality.trim()]
                .filter(Boolean)
                .join(', ') ||
              `Объявление ${i + 1}`;
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onResume(draft)}
                  aria-label={`Продолжить: ${name}`}
                >
                  {name} · Продолжить
                </button>
                {' — '}
                {steps[form.step]}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
