import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AccountPageEntry from '../../components/account-page-entry';
import { signInCapabilities } from '../../lib/sign-in-capabilities';
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
    section?: string | string[];
  }>;
}) {
  const [{ action, tab, section }, channels] = await Promise.all([
    searchParams,
    signInCapabilities(),
  ]);
  if (
    action === 'recover' &&
    !channels.smsAvailable &&
    !channels.emailAvailable
  )
    redirect('/account/forgot-password');
  const initialTab =
    tab === 'messages' || tab === 'notifications' ? tab : 'favorite';
  return (
    <main id="content">
      <AccountPageEntry
        key={[initialTab, section === 'contacts', action === 'recover'].join(
          '-',
        )}
        initialContacts={section === 'contacts'}
        initialTab={initialTab}
        {...channels}
        recoverAccess={action === 'recover'}
        continueListing={action === 'publish'}
        continueFeedback={action === 'feedback'}
      />
    </main>
  );
}
