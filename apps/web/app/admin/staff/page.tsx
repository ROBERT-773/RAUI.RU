import type { Metadata } from 'next';
import StaffPermissions from '../../../components/staff-permissions';
export const metadata: Metadata = {
  title: 'Права сотрудников — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <StaffPermissions />
    </main>
  );
}
