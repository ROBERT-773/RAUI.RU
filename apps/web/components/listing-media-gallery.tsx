import Image from 'next/image';

type Media = { id: string; kind: string; state: string };

export default function ListingMediaGallery({
  media,
  photoCount,
  refreshNeeded,
  editable,
  removalDisabled,
  onRemove,
}: {
  media: Media[];
  photoCount: number;
  refreshNeeded: boolean;
  editable: boolean;
  removalDisabled: boolean;
  onRemove: (item: Media) => void;
}) {
  return (
    <>
      <h3>Фотографии</h3>
      <p>Загружено фотографий: {photoCount} из 21.</p>
      {refreshNeeded && (
        <p role="status">Список файлов не обновился. Проверяем его повторно.</p>
      )}
      <p>JPEG, PNG или WebP, до 10 МБ. После загрузки дождитесь обработки.</p>
      <ul>
        {media.map((item) => {
          const plan = item.kind === 'floor_plan';
          const ready = item.state === 'ready';
          const failed = item.state === 'failed';
          return (
            <li key={item.id}>
              {ready ? (
                <Image
                  unoptimized
                  src={`/api/v1/media/${item.id}/small`}
                  width={240}
                  height={180}
                  alt={plan ? 'Планировка объекта' : 'Фотография объекта'}
                />
              ) : failed ? (
                plan ? (
                  'Ошибка обработки планировки'
                ) : (
                  'Ошибка обработки фотографии'
                )
              ) : plan ? (
                'Планировка обрабатывается'
              ) : (
                'Фотография обрабатывается'
              )}
              {editable &&
                (plan || item.kind === 'photo') &&
                (ready || failed) && (
                  <button
                    type="button"
                    disabled={removalDisabled}
                    onClick={() => {
                      if (
                        window.confirm(
                          plan
                            ? 'Удалить планировку из объявления?'
                            : 'Удалить фотографию из объявления?',
                        )
                      )
                        onRemove(item);
                    }}
                  >
                    {plan
                      ? 'Удалить планировку'
                      : failed
                        ? 'Удалить фото с ошибкой'
                        : 'Удалить фото'}
                  </button>
                )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
