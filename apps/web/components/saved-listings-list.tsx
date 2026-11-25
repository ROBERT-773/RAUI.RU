import CabinetListingsTable from './cabinet-listings-table';
import type { Ref } from 'react';

type Props = {
  headingRef?: Ref<HTMLHeadingElement>;
  items: {
    id: string;
    title: string;
    status: string;
    address?: string | undefined;
    price?: string | null | undefined;
    area?: string | null | undefined;
    floor?: string | null | undefined;
    deal_type?: string | undefined;
    representation?: string | undefined;
  }[];
  loadFailed: boolean;
  checking: boolean;
  more: boolean;
  filtered?: boolean;
  retryDisabled: boolean;
  openDisabled: boolean;
  loadMoreDisabled: boolean;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
};

export default function SavedListingsList({
  headingRef,
  items,
  loadFailed,
  checking,
  more,
  filtered = false,
  retryDisabled,
  openDisabled,
  loadMoreDisabled,
  onRetry,
  onOpen,
  onLoadMore,
}: Props) {
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        Сохранённые объявления
      </h2>
      {loadFailed ? (
        <>
          <p role="status">Не удалось загрузить список объявлений.</p>
          <button type="button" disabled={retryDisabled} onClick={onRetry}>
            Повторить загрузку объявлений
          </button>
        </>
      ) : (
        !items.length &&
        !checking && (
          <p>
            {filtered
              ? 'По этим фильтрам объявлений нет.'
              : 'Объявлений пока нет.'}
          </p>
        )
      )}
      <CabinetListingsTable
        label="Сохранённые объявления"
        rows={items.map((item) => ({
          ...item,
          dealType: item.deal_type,
          object: (
            <>
              <button
                type="button"
                aria-labelledby={'saved-title-' + item.id}
                disabled={openDisabled}
                onClick={() => onOpen(item.id)}
              >
                <span id={'saved-title-' + item.id}>
                  {item.title || item.address || 'Без названия'}
                </span>
                {item.address && item.title && (
                  <span style={{ display: 'block' }}>{item.address}</span>
                )}
              </button>
              {item.representation !== undefined && (
                <span>{item.representation}</span>
              )}
            </>
          ),
        }))}
      />
      {more && (
        <button type="button" disabled={loadMoreDisabled} onClick={onLoadMore}>
          Показать ещё объявления
        </button>
      )}
    </>
  );
}
