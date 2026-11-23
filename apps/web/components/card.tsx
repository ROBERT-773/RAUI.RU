'use client';
import Link from 'next/link';
import Image from 'next/image';
import type { ListingCard } from '@raui/types/product';
import { money, track } from '../lib/client';
import { dealLabel, pricePeriod } from '../lib/labels';
export function Card({
  listing,
  actions,
  summary,
  searchContext,
}: {
  listing: Pick<
    ListingCard,
    'id' | 'title' | 'price' | 'deal_type' | 'address' | 'attributes' | 'media'
  >;
  actions?: React.ReactNode;
  summary?: string;
  searchContext?: { definition: string; mode: 'list' | 'map' };
}) {
  const deal = dealLabel(listing.deal_type);
  return (
    <article className="card">
      {listing.media[0] ? (
        <Image
          src={'/api' + listing.media[0].url}
          alt="Фото объекта"
          width={640}
          height={480}
          sizes="(max-width: 700px) 100vw, 33vw"
          unoptimized
        />
      ) : (
        <div className="photo-placeholder" aria-label="Фото пока нет">
          RAUI
        </div>
      )}
      <div className="card-body">
        {deal && <p className="deal-type">{deal}</p>}
        <h2>
          <Link
            href={{
              pathname: '/listings/' + listing.id,
              query: searchContext,
            }}
            onClick={() =>
              track({ type: 'result_viewed', listingId: listing.id })
            }
          >
            {listing.title}
          </Link>
        </h2>
        <p className="price">
          {money(listing.price)}
          {pricePeriod(listing.deal_type)}
        </p>
        <p>{listing.address}</p>
        {summary && <p className="card-summary">{summary}</p>}
        <p>
          {String(listing.attributes.area ?? '—')} м² ·{' '}
          {String(listing.attributes.rooms ?? '—')} комн.
        </p>
        {actions}
      </div>
    </article>
  );
}
