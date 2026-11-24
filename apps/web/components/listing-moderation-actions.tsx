import type { ReactNode } from 'react';

type Props = {
  status: string;
  withdrawDisabled: boolean;
  previewDisabled: boolean;
  onWithdraw: () => void;
  onPreview: () => void;
  children: ReactNode;
};

export default function ListingModerationActions({
  status,
  withdrawDisabled,
  previewDisabled,
  onWithdraw,
  onPreview,
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
          <button type="button" disabled={previewDisabled} onClick={onPreview}>
            Перейти к предпросмотру
          </button>
        </>
      )}
    </>
  );
}
