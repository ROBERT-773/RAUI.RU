import type { Metadata } from 'next';
import OwnerListings from '../../../components/owner-listings';
import { publicRegions } from '../../../lib/server';
export const metadata: Metadata = {
  title: 'Мои объявления — RAUI.RU',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ agency?: string | string[] }>;
}) {
  const [regions, { agency }] = await Promise.all([
    publicRegions(),
    searchParams,
  ]);
  return (
    <main id="content">
      <OwnerListings
        regions={regions}
        initialAgencyId={typeof agency === 'string' ? agency : ''}
      />
    </main>
  );
}
