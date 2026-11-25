import type { Metadata } from 'next';
import AdminSearch from '../../../components/admin-search';
import StaffTwoFactor from '../../../components/staff-two-factor';

export const metadata: Metadata = {
  title: 'Поиск пользователей и объявлений — RAUI.RU',
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <AdminSearch />
      </StaffTwoFactor>
    </main>
  );
}
