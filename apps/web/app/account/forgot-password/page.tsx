import type { Metadata } from 'next';
import Link from 'next/link';
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
  const [params, channels] = await Promise.all([
    searchParams,
    signInCapabilities(),
  ]);
  if (
    (params.mode !== 'password' || !channels.resetLinkAvailable) &&
    (channels.emailAvailable || channels.smsAvailable)
  )
    redirect('/account?action=recover');
  return (
    <main id="content">
      {channels.resetLinkAvailable ? (
        <PasswordRecovery />
      ) : (
        <>
          <h1>Восстановить доступ</h1>
          <p>
            Отправка кодов и писем для восстановления временно недоступна.
            Попробуйте позже.
          </p>
          <Link href="/account">Вернуться ко входу</Link>
        </>
      )}
    </main>
  );
}
