'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { ListingCard } from '@raui/types/product';
import { money, track } from '../lib/client';
import { dealLabel, pricePeriod } from '../lib/labels';
import styles from './card.module.css';

function numericValue(value: unknown) {
  const number =
    typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function floorLabel(floorValue: unknown, floorsValue: unknown) {
  const floor = numericValue(floorValue);
  const floors = numericValue(floorsValue);
  const hasFloors =
    floors !== null && Number.isSafeInteger(floors) && floors > 0;
  if (floor === null || !Number.isSafeInteger(floor))
    return hasFloors ? `Этажей в доме — ${floors}` : null;
  if (!hasFloors) return `${floor} этаж`;
  return floor <= floors ? `${floor}/${floors} этаж` : null;
}

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
  const price = numericValue(listing.price);
  const attributes = listing.attributes;
  const area = numericValue(attributes?.area);
  const rooms = numericValue(attributes?.rooms);
  const facts = [];
  if (area !== null && area > 0)
    facts.push(`${area.toLocaleString('ru-RU')} м²`);
  if (rooms !== null && Number.isSafeInteger(rooms) && rooms >= 0)
    facts.push(rooms === 0 ? 'Студия' : `${rooms} комн.`);
  const floor = floorLabel(attributes?.floor, attributes?.floors);
  if (floor) facts.push(floor);
  const pricePerM2 =
    listing.deal_type === 'sale' &&
    price !== null &&
    price > 0 &&
    area !== null &&
    area > 0
      ? price / area
      : null;

  return (
    <article className="card">
      <h2 className={styles.heading}>
        <Link
          className={styles.link}
          href={{ pathname: '/listings/' + listing.id, query: searchContext }}
          onClick={() =>
            track({ type: 'result_viewed', listingId: listing.id })
          }
        >
          {listing.media[0] ? (
            <Image
              src={'/api' + listing.media[0].url}
              alt=""
              width={640}
              height={480}
              sizes="(max-width: 700px) 100vw, 33vw"
              unoptimized
            />
          ) : (
            <span className="photo-placeholder" aria-hidden="true">
              Фото пока нет
            </span>
          )}
          <span className={styles.title}>{listing.title}</span>
        </Link>
      </h2>
      <div className="card-body">
        {deal && <p className="deal-type">{deal}</p>}
        {price !== null && price > 0 && (
          <p className="price">
            {money(price)}
            {pricePeriod(listing.deal_type)}
          </p>
        )}
        {pricePerM2 !== null && Number.isFinite(pricePerM2) && (
          <p>{pricePerM2 < 1 ? 'Менее 1 ₽' : money(pricePerM2)}/м²</p>
        )}
        <p>{listing.address}</p>
        {summary && <p className="card-summary">{summary}</p>}
        {facts.length > 0 && <p>{facts.join(' · ')}</p>}
        {actions}
      </div>
    </article>
  );
}
