import type { Metadata } from 'next';
import StaffPermissions from '../../../components/staff-permissions';
import StaffTwoFactor from '../../../components/staff-two-factor';
export const metadata: Metadata = {
  title: 'Права сотрудников — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <StaffPermissions />
      </StaffTwoFactor>
    </main>
  );
}
