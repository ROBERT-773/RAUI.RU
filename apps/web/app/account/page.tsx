import type { Metadata } from 'next';
import Account from '../../components/account';
export const metadata: Metadata = {
  title: 'Аккаунт — RAUI.RU',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ action?: string | string[] }>;
}) {
  const { action } = await searchParams;
  return (
    <main id="content">
      <Account continueListing={action === 'publish'} />
    </main>
  );
}
