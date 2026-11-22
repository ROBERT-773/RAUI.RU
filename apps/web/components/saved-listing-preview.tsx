import Image from 'next/image';
import { dealLabel, formatListingPrice } from '../lib/labels';
import { listingAttributeFields } from '../lib/listing-attribute-fields';
import { rentalFacts } from '../lib/rental-facts';
import type { ListingTerms } from './listing-terms';

export default function SavedListingPreview({
  listing,
  property,
  propertyFields,
  media,
}: {
  listing: {
    title: string;
    deal_type: string;
    price: string | null;
    description: string;
    terms?: ListingTerms;
  };
  property: {
    category_code: string;
    attributes: Record<string, unknown>;
    address?: { formatted: string };
  } | null;
  propertyFields: { code: string; name: string; required: boolean }[];
  media: { id: string; kind: string; state: string }[];
}) {
  const savedRentalFacts =
    listing && ['long_rent', 'short_rent'].includes(listing.deal_type)
      ? rentalFacts(listing.terms ?? {})
      : [];
  return (
    <details>
      <summary>Предпросмотр объявления</summary>
      <section aria-label="Сохранённые данные объявления">
        <h3>{listing.title || 'Черновик объявления'}</h3>
        <p>{dealLabel(listing.deal_type)}</p>
        {property?.address?.formatted && <p>{property.address.formatted}</p>}
        {listing.price && (
          <p>{formatListingPrice(listing.price, listing.deal_type)}</p>
        )}
        {savedRentalFacts.length > 0 && (
          <dl aria-label="Условия аренды">
            {savedRentalFacts.map(({ label, value }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {listing.deal_type === 'sale' && listing.terms?.negotiable === true && (
          <p>Возможен торг</p>
        )}
        <p style={{ whiteSpace: 'pre-wrap' }}>
          {listing.description.trim() || 'Описание ещё не сохранено.'}
        </p>
        {property && (
          <dl>
            {listingAttributeFields(
              property.category_code,
              propertyFields,
              property.attributes.commercial_property_type,
            ).map(({ code, name }) => {
              const value = property.attributes[code];
              if (value == null || value === '') return null;
              return (
                <div key={code}>
                  <dt>{name}</dt>
                  <dd>
                    {typeof value === 'boolean'
                      ? value
                        ? 'Да'
                        : 'Нет'
                      : String(value)}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        {media
          .filter(({ state }) => state === 'ready')
          .sort(
            (left, right) =>
              Number(right.kind === 'photo') - Number(left.kind === 'photo'),
          )
          .map((item) => (
            <Image
              key={item.id}
              unoptimized
              src={`/api/v1/media/${item.id}/small`}
              width={160}
              height={120}
              alt={
                item.kind === 'floor_plan'
                  ? 'Планировка в предпросмотре'
                  : 'Фото в предпросмотре'
              }
            />
          ))}
      </section>
    </details>
  );
}
