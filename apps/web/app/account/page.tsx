import type { Metadata } from 'next';
import Account from '../../components/account';
export const metadata: Metadata = {
  title: 'Аккаунт — RAUI.RU',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string | string[];
    tab?: string | string[];
  }>;
}) {
  const { action, tab } = await searchParams;
  const initialTab =
    tab === 'messages' || tab === 'notifications' ? tab : 'favorite';
  return (
    <main id="content">
      <Account
        key={initialTab}
        initialTab={initialTab}
        continueListing={action === 'publish'}
      />
    </main>
  );
}
