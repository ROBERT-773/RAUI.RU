import AdminSupport from '../../../components/admin-support';
import StaffTwoFactor from '../../../components/staff-two-factor';
export const metadata = {
  title: 'Обращения в поддержку',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <AdminSupport />
      </StaffTwoFactor>
    </main>
  );
}
