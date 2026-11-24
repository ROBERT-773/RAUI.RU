import Image from 'next/image';
import { attributeValue, dealLabel, formatListingPrice } from '../lib/labels';
import { listingAttributeFields } from '../lib/listing-attribute-fields';
import { rentalFacts } from '../lib/rental-facts';
import type { ListingTerms } from './listing-terms';
import styles from './saved-listing-preview.module.css';
import { PreviewContacts } from './listing-contacts';
import type { ListingContactSettings } from '../lib/contact-settings';

export default function SavedListingPreview({
  listing,
  property,
  propertyFields,
  media,
  contacts,
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
  contacts?: ListingContactSettings | null;
}) {
  const savedRentalFacts = ['long_rent', 'short_rent'].includes(
    listing.deal_type,
  )
    ? rentalFacts(listing.terms ?? {})
    : [];
  const readyMedia = media
    .filter(({ state }) => state === 'ready')
    .sort(
      (left, right) =>
        Number(right.kind === 'photo') - Number(left.kind === 'photo'),
    );
  return (
    <section
      className={styles.preview}
      aria-label="Сохранённые данные объявления"
    >
      {readyMedia.length > 0 && (
        <div
          className={styles.gallery}
          role="region"
          aria-label="Фотографии и планировка"
          tabIndex={0}
        >
          {readyMedia.map((item) => (
            <Image
              key={item.id}
              unoptimized
              src={`/api/v1/media/${item.id}/small`}
              width={800}
              height={600}
              alt={
                item.kind === 'floor_plan'
                  ? 'Планировка в предпросмотре'
                  : 'Фото в предпросмотре'
              }
            />
          ))}
        </div>
      )}
      <h3 className={styles.title}>{listing.title || 'Черновик объявления'}</h3>
      <p>{dealLabel(listing.deal_type)}</p>
      {listing.price && (
        <p className={styles.price}>
          {formatListingPrice(listing.price, listing.deal_type)}
        </p>
      )}
      {property?.address?.formatted && <p>{property.address.formatted}</p>}
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
                <dd>{attributeValue(value)}</dd>
              </div>
            );
          })}
        </dl>
      )}
      <p className={styles.description}>
        {listing.description.trim() || 'Описание ещё не сохранено.'}
      </p>
      {contacts && <PreviewContacts settings={contacts} />}
    </section>
  );
}
