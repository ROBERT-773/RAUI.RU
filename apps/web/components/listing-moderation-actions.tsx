import type { ReactNode } from 'react';

type Props = {
  status: string;
  withdrawDisabled: boolean;
  submitDisabled: boolean;
  onWithdraw: () => void;
  onSubmit: () => void;
  children: ReactNode;
};

export default function ListingModerationActions({
  status,
  withdrawDisabled,
  submitDisabled,
  onWithdraw,
  onSubmit,
  children,
}: Props) {
  return (
    <>
      {['processing', 'moderation'].includes(status) && (
        <button type="button" disabled={withdrawDisabled} onClick={onWithdraw}>
          {status === 'moderation'
            ? 'Отозвать с модерации'
            : 'Вернуть в черновик'}
        </button>
      )}
      {['draft', 'paused', 'rejected', 'processing'].includes(status) && (
        <>
          {children}
          <button type="button" disabled={submitDisabled} onClick={onSubmit}>
            Отправить на модерацию
          </button>
        </>
      )}
    </>
  );
}
