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
      {deal && <p className="deal-type">{deal}</p>}
      <h1>{data.title}</h1>
      <p className="price">{formatListingPrice(data.price, data.dealType)}</p>
      <p>{data.property.formatted}</p>
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
      {[
        { title: 'Фотографии', alt: 'Фото недвижимости', isPlan: false },
        { title: 'Планировки', alt: 'Планировка объекта', isPlan: true },
      ].map(({ title, alt, isPlan }) => {
        const images = data.media.flatMap((item) => {
          if ((item.kind === 'floor_plan') !== isPlan) return [];
          const size = item.variants.large ? 'large' : 'small';
          const variant = item.variants[size];
          return variant ? [{ id: item.id, size, variant }] : [];
        });
        return (
          images.length > 0 && (
            <section key={title} aria-label={title}>
              <h2>{title}</h2>
              {images.map(({ id: mediaId, size, variant }) => {
                const src = '/api/v1/media/' + mediaId + '/' + size;
                return (
                  <div key={mediaId}>
                    <Image
                      className="detail-photo"
                      src={src}
                      alt={alt}
                      width={variant.width}
                      height={variant.height}
                      sizes="100vw"
                      unoptimized
                    />
                    {isPlan && (
                      <p>
                        <a href={src} target="_blank" rel="noopener">
                          Открыть планировку в новой вкладке
                        </a>
                      </p>
                    )}
                  </div>
                );
              })}
            </section>
          )
        );
      })}
      <section className="panel">
        <h2>Описание</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{data.description}</p>
        <dl>
          {Object.entries(data.property.attributes).map(([key, v]) => (
            <div key={key}>
              <dt>{attributeLabels[key] ?? key}</dt>
              <dd>{attributeValue(v)}</dd>
            </div>
          ))}
        </dl>
      </section>
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
      <DetailActions id={id} />
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
