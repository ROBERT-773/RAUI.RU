export default function ListingUploadControls({
  blocked,
  photoCount,
  onFiles,
}: {
  blocked: boolean;
  photoCount: number;
  onFiles: (kind: 'photo' | 'floor_plan', files: File[]) => void;
}) {
  return (
    <>
      {(['photo', 'floor_plan'] as const).map((kind) => {
        const label =
          kind === 'photo' ? 'Добавить фотографию' : 'Добавить планировку';
        const disabled = blocked || (kind === 'photo' && photoCount >= 21);
        return (
          <div
            key={kind}
            className="listing-upload"
            role="group"
            aria-label={
              kind === 'photo' ? 'Загрузка фотографий' : 'Загрузка планировки'
            }
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              if (!disabled)
                onFiles(kind, Array.from(event.dataTransfer.files));
            }}
          >
            <label>
              {label}
              <input
                type="file"
                multiple={kind === 'photo'}
                accept="image/jpeg,image/png,image/webp"
                disabled={disabled}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  onFiles(kind, files);
                }}
              />
            </label>
            <small>
              {kind === 'photo'
                ? 'Или перетащите сюда фотографии'
                : 'Или перетащите сюда файл планировки'}
            </small>
          </div>
        );
      })}
    </>
  );
}
