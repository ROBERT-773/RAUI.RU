import Link from 'next/link';

type Props = {
  listingId: string;
  status: string;
  disabled: boolean;
  hasUnsavedChanges: boolean;
  onPause: () => void;
  onArchive: () => void;
};

export default function ListingPublicationActions({
  listingId,
  status,
  disabled,
  hasUnsavedChanges,
  onPause,
  onArchive,
}: Props) {
  if (status !== 'published' && status !== 'paused') return null;

  return (
    <>
      {status === 'published' && (
        <>
          <Link href={`/listings/${listingId}`}>
            Открыть опубликованное объявление
          </Link>
          <p>Для редактирования сначала приостановите размещение.</p>
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
