import type { Metadata } from 'next';
import ModerationWorkbench from '../../../components/moderation-workbench';
import StaffTwoFactor from '../../../components/staff-two-factor';
export const metadata: Metadata = {
  title: 'Проверка объявлений — RAUI.RU',
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <main id="content">
      <StaffTwoFactor>
        <ModerationWorkbench />
      </StaffTwoFactor>
    </main>
  );
}
