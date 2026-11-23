import { listingStatusLabel } from './listing-editor-status';

type Props = {
  items: {
    id: string;
    title: string;
    status: string;
    representation?: string | undefined;
  }[];
  loadFailed: boolean;
  checking: boolean;
  more: boolean;
  retryDisabled: boolean;
  openDisabled: boolean;
  loadMoreDisabled: boolean;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
};

export default function SavedListingsList({
  items,
  loadFailed,
  checking,
  more,
  retryDisabled,
  openDisabled,
  loadMoreDisabled,
  onRetry,
  onOpen,
  onLoadMore,
}: Props) {
  return (
    <>
      <h2>Сохранённые объявления</h2>
      {loadFailed ? (
        <>
          <p role="status">Не удалось загрузить список объявлений.</p>
          <button type="button" disabled={retryDisabled} onClick={onRetry}>
            Повторить загрузку объявлений
          </button>
        </>
      ) : (
        !items.length && !checking && <p>Объявлений пока нет.</p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              disabled={openDisabled}
              onClick={() => onOpen(item.id)}
            >
              {item.title || 'Без названия'}
            </button>{' '}
            — {listingStatusLabel(item.status)}
            {item.representation !== undefined && (
              <span>
                {' · '}
                {item.representation}
              </span>
            )}
          </li>
        ))}
      </ul>
      {more && (
        <button type="button" disabled={loadMoreDisabled} onClick={onLoadMore}>
          Показать ещё объявления
        </button>
      )}
    </>
  );
}
