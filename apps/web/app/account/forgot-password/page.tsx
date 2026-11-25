import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import PasswordRecovery from '../../../components/password-recovery';
import { signInCapabilities } from '../../../lib/sign-in-capabilities';
export const metadata: Metadata = {
  title: 'Восстановить пароль — RAUI.RU',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  if ((await searchParams).mode !== 'password') {
    const channels = await signInCapabilities();
    if (channels.emailAvailable || channels.smsAvailable)
      redirect('/account?action=recover');
  }
  return (
    <main id="content">
      <PasswordRecovery />
    </main>
  );
}
