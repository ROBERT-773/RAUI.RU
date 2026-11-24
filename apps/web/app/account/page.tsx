import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Account from '../../components/account';
import { backendFetch } from '../../lib/backend';
export const metadata: Metadata = {
  title: 'Аккаунт — RAUI.RU',
  robots: { index: false, follow: false },
};
async function smsAvailable() {
  try {
    const response = await backendFetch(
      '/v1/auth/phone-sign-in/capabilities',
      await headers(),
    );
    return response.ok && (await response.json()).available === true;
  } catch {
    return false;
  }
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string | string[];
    tab?: string | string[];
    section?: string | string[];
  }>;
}) {
  const { action, tab, section } = await searchParams;
  const initialTab =
    tab === 'messages' || tab === 'notifications' ? tab : 'favorite';
  return (
    <main id="content">
      <Account
        key={section === 'contacts' ? initialTab + '-contacts' : initialTab}
        initialContacts={section === 'contacts'}
        initialTab={initialTab}
        smsAvailable={await smsAvailable()}
        continueListing={action === 'publish'}
      />
    </main>
  );
}
