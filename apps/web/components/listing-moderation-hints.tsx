export default function ListingModerationHints({
  photosReady,
  readyPhotos,
  hasUnsavedChanges,
  offerError,
  descriptionTooShort,
  missingFieldNames,
}: {
  photosReady: boolean;
  readyPhotos: number;
  hasUnsavedChanges: boolean;
  offerError: string | undefined;
  descriptionTooShort: boolean;
  missingFieldNames: string[];
}) {
  return (
    <>
      {!photosReady && (
        <p>
          Для отправки нужно от 5 до 21 обработанной фотографии. Сейчас готово:{' '}
          {readyPhotos}. Дождитесь завершения обработки всех файлов и устраните
          ошибки загрузки.
        </p>
      )}
      {hasUnsavedChanges && <p>Сохраните изменения перед отправкой.</p>}
      {offerError && <p>{offerError}</p>}
      {descriptionTooShort && (
        <p>Перед отправкой сохраните описание длиной не менее 15 символов.</p>
      )}
      {missingFieldNames.length > 0 && (
        <p>
          Заполните обязательные характеристики: {missingFieldNames.join('; ')}.
        </p>
      )}
    </>
  );
}
