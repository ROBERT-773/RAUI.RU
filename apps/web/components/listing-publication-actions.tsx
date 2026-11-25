import Link from 'next/link';
import { useState } from 'react';

type Props = {
  listingId: string;
  initialEdit?: boolean;
  status: string;
  disabled: boolean;
  hasUnsavedChanges: boolean;
  onPause: () => void;
  onArchive: () => void;
};

export default function ListingPublicationActions({
  listingId,
  initialEdit = false,
  status,
  disabled,
  hasUnsavedChanges,
  onPause,
  onArchive,
}: Props) {
  const [confirmEdit, setConfirmEdit] = useState(initialEdit);
  if (status !== 'published' && status !== 'paused') return null;

  return (
    <>
      {status === 'published' && (
        <>
          <Link href={`/listings/${listingId}`}>
            Открыть опубликованное объявление
          </Link>
          {confirmEdit ? (
            <div>
              <p>
                Объявление временно исчезнет из поиска. После правок отправьте
                его на модерацию, чтобы возобновить показ.
              </p>
              <button type="button" disabled={disabled} onClick={onPause}>
                Приостановить и редактировать
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setConfirmEdit(false)}
              >
                Отмена
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setConfirmEdit(true)}
            >
              Редактировать
            </button>
          )}
          <button type="button" disabled={disabled} onClick={onPause}>
            Приостановить
          </button>
        </>
      )}
      <button
        type="button"
        disabled={disabled || hasUnsavedChanges}
        onClick={onArchive}
      >
        В архив
      </button>
    </>
  );
}
