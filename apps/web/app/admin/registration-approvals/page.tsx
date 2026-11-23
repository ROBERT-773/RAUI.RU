import type { Metadata } from 'next';
import RegistrationApprovals from '../../../components/registration-approvals';
import StaffTwoFactor from '../../../components/staff-two-factor';
export const metadata: Metadata = {
  title: 'Заявки на регистрацию — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <RegistrationApprovals />
      </StaffTwoFactor>
    </main>
  );
}
