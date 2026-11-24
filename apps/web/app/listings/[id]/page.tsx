import { headers } from 'next/headers';
import { jsonLd } from '../../../lib/security';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { detail, site } from '../../../lib/server';
import {
  attributeLabels,
  attributeValue,
  dealLabel,
  formatListingPrice,
} from '../../../lib/labels';
import { rentalFacts } from '../../../lib/rental-facts';
import { moscowPath } from '../../../lib/moscow-search';
import DetailActions from '../../../components/detail-actions';
import PublicPhotoGallery from '../../../components/public-photo-gallery';
import ListingLocationMap from '../../../components/listing-location-map';
import { catalogHref } from '../../../lib/catalog-links';
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const data = await detail(id);
  if (!data) notFound();
  return data
    ? {
        title: data.title + ' — RAUI.RU',
        description: data.description.slice(0, 160),
        alternates: { canonical: site + '/listings/' + id },
        openGraph: {
          title: data.title,
          description: data.description.slice(0, 160),
        },
        robots: { index: true, follow: true },
      }
    : {
        title: 'Объявление недоступно',
        robots: { index: false, follow: false },
      };
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ definition?: string; mode?: string }>;
}) {
  const { id } = await params,
    data = await detail(id);
  if (!data) notFound();
  const { definition, mode } = await searchParams;
  const hasSearchContext =
    typeof definition === 'string' && definition.length <= 16000;
  const deal = dealLabel(data.dealType);
  const facts = rentalFacts(data.rentalTerms ?? {});
  const images = data.media.flatMap((item) => {
    const size = item.variants.large ? 'large' : 'small';
    const variant = item.variants[size];
    return variant
      ? [
          {
            kind: item.kind,
            src: `/api/v1/media/${item.id}/${size}`,
            width: variant.width,
            height: variant.height,
          },
        ]
      : [];
  });
  const plans = images.filter((image) => image.kind === 'floor_plan');
  const { latitude, longitude } = data.property;
  const locationUrl =
    Number.isFinite(longitude) && Number.isFinite(latitude)
      ? catalogHref({
          bounds: [
            Math.max(-180, longitude - 0.008),
            Math.max(-90, latitude - 0.004),
            Math.min(180, longitude + 0.008),
            Math.min(90, latitude + 0.004),
          ],
        }) + '&mode=map'
      : null;
  const catalog =
    data.property.category_code === 'apartment' &&
    data.property.locality === 'Москва'
      ? moscowPath(data.dealType)
      : null;
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: data.title,
    description: data.description,
    url: site + '/listings/' + id,
    offers: { '@type': 'Offer', price: data.price, priceCurrency: 'RUB' },
    contentLocation: {
      '@type': 'Place',
      address: data.property.formatted,
      geo: {
        '@type': 'GeoCoordinates',
        latitude: data.property.latitude,
        longitude: data.property.longitude,
      },
    },
  };
  return (
    <main id="content">
      <nav className="catalog-navigation" aria-label="Навигация по каталогу">
        {hasSearchContext && (
          <Link
            href={{
              pathname: '/search',
              query: { definition, mode: mode === 'map' ? 'map' : 'list' },
            }}
          >
            Назад к результатам
          </Link>
        )}
        <Link href={catalog ?? '/search'}>
          {catalog ? 'К разделу в Москве' : 'Все объявления'}
        </Link>
      </nav>
      <PublicPhotoGallery
        key={id}
        photos={images.filter((image) => image.kind === 'photo')}
      />
      {deal && <p className="deal-type">{deal}</p>}
      <h1>{data.title}</h1>
      <p className="price">{formatListingPrice(data.price, data.dealType)}</p>
      <p>{data.property.formatted}</p>
      {locationUrl && (
        <>
          <ListingLocationMap latitude={latitude} longitude={longitude} />
          <p>
            <Link href={locationUrl}>Объявления рядом на карте</Link>
          </p>
        </>
      )}
      {facts.length > 0 && (
        <section className="panel">
          <h2>Условия аренды</h2>
          <dl>
            {facts.map(({ label, value }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {Object.keys(data.property.attributes).length > 0 && (
        <section className="panel">
          <h2>Характеристики</h2>
          <dl>
            {Object.entries(data.property.attributes).map(([key, v]) => (
              <div key={key}>
                <dt>{attributeLabels[key] ?? key}</dt>
                <dd>{attributeValue(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {plans.length > 0 && (
        <section aria-label="Планировки">
          <h2>Планировки</h2>
          {plans.map(({ src, width, height }) => (
            <div key={src}>
              <Image
                className="detail-photo"
                src={src}
                alt="Планировка объекта"
                width={width}
                height={height}
                sizes="100vw"
                unoptimized
              />
              <p>
                <a href={src} target="_blank" rel="noopener">
                  Открыть планировку в новой вкладке
                </a>
              </p>
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <h2>Описание</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{data.description}</p>
      </section>
      <DetailActions id={id} />
      {!!data.professionals?.length && (
        <section aria-labelledby="listing-professionals">
          <h2 id="listing-professionals">Кто разместил объявление</h2>
          <ul>
            {data.professionals.map((profile) => (
              <li key={profile.id}>
                {profile.kind === 'agent' ? 'Агент' : 'Агентство'}{' '}
                <Link href={'/professionals/' + profile.id}>
                  {profile.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <script
        type="application/ld+json"
        nonce={(await headers()).get('x-nonce') ?? undefined}
        dangerouslySetInnerHTML={{
          __html: jsonLd(structured),
        }}
      />
    </main>
  );
}
