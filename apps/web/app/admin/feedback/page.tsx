import type { Metadata } from 'next';
import AdminFeedback from '../../../components/admin-feedback';
import StaffTwoFactor from '../../../components/staff-two-factor';

export const metadata: Metadata = {
  title: 'Предложения о портале — RAUI.RU',
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <AdminFeedback />
      </StaffTwoFactor>
    </main>
  );
}
