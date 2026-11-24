import type { Metadata } from 'next';
import AdminFeedTrust from '../../../components/admin-feed-trust';
import StaffTwoFactor from '../../../components/staff-two-factor';

export const metadata: Metadata = {
  title: 'Автопубликация из XML — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <AdminFeedTrust />
      </StaffTwoFactor>
    </main>
  );
}
