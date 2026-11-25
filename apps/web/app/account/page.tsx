import type { Metadata } from 'next';
import Account from '../../components/account';
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
  const { action, tab, section } = await searchParams;
  const initialTab =
    tab === 'messages' || tab === 'notifications' ? tab : 'favorite';
  return (
    <main id="content">
      <Account
        key={[initialTab, section === 'contacts', action === 'recover'].join(
          '-',
        )}
        initialContacts={section === 'contacts'}
        initialTab={initialTab}
        {...await signInCapabilities()}
        recoverAccess={action === 'recover'}
        continueListing={action === 'publish'}
        continueFeedback={action === 'feedback'}
      />
    </main>
  );
}
