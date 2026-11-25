import Image from 'next/image';
import Link from 'next/link';
import type { ProfessionalSummary, SellerType } from '../lib/server';
import styles from './professional-identity.module.css';

const roles: Record<SellerType, string> = {
  owner: 'Собственник',
  agent: 'Агент по недвижимости',
  agency: 'Агентство недвижимости',
  developer: 'Застройщик',
  other: 'Автор объявления',
};

export function ProfessionalIdentity({
  profile,
  heading = false,
}: {
  profile: ProfessionalSummary;
  heading?: boolean;
}) {
  const href = '/professionals/' + encodeURIComponent(profile.id);
  return (
    <div className={styles.identity}>
      {profile.imageId && (
        <Image
          className={profile.kind === 'agency' ? styles.logo : styles.portrait}
          src={
            '/api/v1/search' +
            href +
            '/image/' +
            encodeURIComponent(profile.imageId)
          }
          width={80}
          height={80}
          alt={profile.kind === 'agency' ? 'Логотип агентства' : 'Фото агента'}
          unoptimized
        />
      )}
      <div className={styles.caption}>
        {heading ? (
          <h1>{profile.name}</h1>
        ) : (
          <Link href={href}>{profile.name}</Link>
        )}
        <p>{roles[profile.kind]}</p>
      </div>
    </div>
  );
}
export function ListingAuthors({
  profiles = [],
  sellerType = 'other',
}: {
  profiles?: ProfessionalSummary[] | undefined;
  sellerType?: SellerType | undefined;
}) {
  return (
    <section className="panel" aria-labelledby="listing-professionals">
      <h2 id="listing-professionals">Кто разместил объявление</h2>
      {profiles.length > 0 ? (
        <ul className={styles.authors}>
          {profiles.map((profile) => (
            <li key={profile.id}>
              <ProfessionalIdentity profile={profile} />
            </li>
          ))}
        </ul>
      ) : (
        <p>{roles[sellerType]}</p>
      )}
    </section>
  );
}
