import type { Metadata } from 'next';
import RegistrationApprovals from '../../../components/registration-approvals';
export const metadata: Metadata = {
  title: 'Заявки на регистрацию — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <RegistrationApprovals />
    </main>
  );
}
