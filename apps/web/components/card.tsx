'use client';
import Link from 'next/link';
import Image from 'next/image';
import type { ListingCard } from '@raui/types/product';
import { money, track } from '../lib/client';
export function Card({
  listing,
  actions,
}: {
  listing: ListingCard;
  actions?: React.ReactNode;
}) {
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
        <h2>
          <Link
            href={'/listings/' + listing.id}
            onClick={() =>
              track({ type: 'result_viewed', listingId: listing.id })
            }
          >
            {listing.title}
          </Link>
        </h2>
        <p className="price">{money(listing.price)}</p>
        <p>{listing.address}</p>
        <p>
          {String(listing.attributes.area ?? '—')} м² ·{' '}
          {String(listing.attributes.rooms ?? '—')} комн.
        </p>
        {actions}
      </div>
    </article>
  );
}
