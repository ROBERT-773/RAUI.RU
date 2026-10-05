import { headers } from 'next/headers';
import { jsonLd } from '../../../lib/security';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Image from 'next/image';
import { detail, site } from '../../../lib/server';
import { attributeLabels, attributeValue } from '../../../lib/labels';
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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    data = await detail(id);
  if (!data) notFound();
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
      <h1>{data.title}</h1>
      <p className="price">
        {new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: 'RUB',
          maximumFractionDigits: 0,
        }).format(Number(data.price))}
      </p>
      <p>{data.property.formatted}</p>
      {data.media.map((m) => {
        const v = m.variants.large ?? m.variants.small;
        return v ? (
          <Image
            key={m.id}
            className="detail-photo"
            src={'/api/v1/media/' + m.id + '/large'}
            alt="Фото недвижимости"
            width={v.width}
            height={v.height}
            sizes="100vw"
            unoptimized
          />
        ) : null;
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
