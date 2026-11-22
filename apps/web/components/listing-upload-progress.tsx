export type UploadProgress = {
  total: number;
  remaining: number;
  kind: 'photo' | 'floor_plan';
  filename: string | undefined;
};

export default function ListingUploadProgress({
  progress,
  busy,
  disabled,
  onRetry,
  onCancel,
}: {
  progress: UploadProgress;
  busy: boolean;
  disabled: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="actions">
      <p role="status">
        Принято файлов {progress.total - progress.remaining} из {progress.total}
        .
        {!busy && progress.filename && (
          <> Загрузка остановилась на файле «{progress.filename}».</>
        )}
      </p>
      <button type="button" disabled={disabled} onClick={onRetry}>
        {progress.kind === 'floor_plan'
          ? 'Повторить загрузку планировки'
          : 'Повторить загрузку фотографии'}
      </button>
      <button type="button" disabled={disabled} onClick={onCancel}>
        Отменить загрузку оставшихся файлов
      </button>
    </div>
  );
}
