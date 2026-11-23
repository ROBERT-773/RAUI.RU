const states: Record<string, string> = {
  draft: 'Черновик',
  processing: 'Подготовка к проверке',
  moderation: 'На модерации',
  published: 'Опубликовано',
  paused: 'Приостановлено',
  rejected: 'Отклонено',
  archived: 'В архиве',
  sold: 'Продано',
  rented: 'Сдано',
};

export const listingStatusLabel = (status: string) => states[status] ?? status;

export default function ListingEditorStatus({
  status,
  representation,
  rejectionReason,
}: {
  status: string;
  representation: string;
  rejectionReason: string;
}) {
  return (
    <>
      <p>Статус: {listingStatusLabel(status)}</p>
      {representation && <p>{representation}</p>}
      {status === 'rejected' && rejectionReason && (
        <p role="status">Причина отклонения: {rejectionReason}</p>
      )}
    </>
  );
}
