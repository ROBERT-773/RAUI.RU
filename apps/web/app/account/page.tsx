import type { Metadata } from 'next';
import Account from '../../components/account';
export const metadata: Metadata = {
  title: 'Аккаунт — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <Account />
    </main>
  );
}
