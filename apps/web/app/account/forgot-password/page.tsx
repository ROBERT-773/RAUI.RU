import type { Metadata } from 'next';
import PasswordRecovery from '../../../components/password-recovery';
export const metadata: Metadata = {
  title: 'Восстановить пароль — RAUI.RU',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function Page() {
  return (
    <main id="content">
      <PasswordRecovery />
    </main>
  );
}
