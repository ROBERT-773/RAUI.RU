import Link from 'next/link';
import { TicketStatus } from '../../../components/support-ticket';
import styles from '../support.module.css';
export const metadata = {
  title: 'Моё обращение',
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};
export default function Page() {
  return (
    <main id="content" className={styles.page}>
      <Link href="/support">Служба поддержки</Link>
      <h1>Моё обращение</h1>
      <TicketStatus />
    </main>
  );
}
