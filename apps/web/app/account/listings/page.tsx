import type { Metadata } from 'next';
import OwnerListings from '../../../components/owner-listings';
export const metadata: Metadata = {
  title: 'Мои объявления — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <OwnerListings />
    </main>
  );
}
