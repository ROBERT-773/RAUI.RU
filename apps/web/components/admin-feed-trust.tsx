'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/client';
import { feedProviders } from './feed-run-report';

interface AdminFeed {
  id: string;
  ownerName: string;
  provider: keyof typeof feedProviders | null;
  host: string | null;
  active: boolean;
  version: number;
  trustEligible: boolean;
  trusted: boolean;
}
const route = 'v1/admin/integrations/feeds';

export default function AdminFeedTrust() {
  const [pages, setPages] = useState(['']);
  const after = pages[pages.length - 1]!;
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<AdminFeed[]>();
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    let current = true;
    api<AdminFeed[]>(
      route + (after ? '?' + new URLSearchParams({ after }) : ''),
    )
      .then((page) => {
        if (current) setRows(page);
      })
      .catch((failure: unknown) => {
        if (current)
          setError(
            failure instanceof ApiError && failure.status === 403
              ? 'Недостаточно прав для управления источниками.'
              : 'Не удалось загрузить источники. Обновите список.',
          );
      });
    return () => {
      current = false;
    };
  }, [after, refresh]);
  function reload() {
    setRows(undefined);
    setRefresh((previous) => previous + 1);
  }
  async function decide(row: AdminFeed) {
    if (changing) return;
    setChanging(true);
    setError('');
    try {
      const updated = await api<AdminFeed>(
        route + '/' + row.id + '/trust',
        'PATCH',
        { version: row.version, trusted: !row.trusted },
      );
      setRows((previous) =>
        previous?.map((source) =>
          source.id === updated.id ? updated : source,
        ),
      );
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 403) {
        setRows(undefined);
        setError('Недостаточно прав для управления источниками.');
      } else {
        setError(
          failure instanceof ApiError && failure.status === 409
            ? 'Состояние источника изменилось. Проверьте обновлённые сведения.'
            : 'Не удалось подтвердить изменение. Проверьте состояние источника.',
        );
        reload();
      }
    } finally {
      setChanging(false);
    }
  }
  const managed = rows?.filter(
    (row) => row.provider && Object.hasOwn(feedProviders, row.provider),
  );
  return (
    <section className="feed-import">
      <h1>Автопубликация из XML</h1>
      <p>
        После одобрения портал запустит импорт объявлений из этого источника и
        будет обновлять их по расписанию.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={changing}
        onClick={() => {
          setError('');
          reload();
        }}
      >
        Обновить список
      </button>
      {!rows && !error && <p role="status">Загружаем источники…</p>}
      {managed?.length === 0 && <p>На этой странице нет XML-ссылок.</p>}
      {managed?.map((row) => (
        <section
          className="feed-row"
          key={row.id}
          aria-label={row.ownerName + ' · ' + feedProviders[row.provider!]}
        >
          <h2>{row.ownerName}</h2>
          <p>
            {feedProviders[row.provider!]} · {row.host}
          </p>
          <p>
            {row.trusted
              ? 'Автопубликация разрешена'
              : !row.active
                ? 'Источник отключён'
                : row.trustEligible
                  ? 'Готов к одобрению'
                  : 'Нужна предварительная проверка действующей ссылки.'}
          </p>
          {(row.trusted || (row.active && row.trustEligible)) && (
            <button disabled={changing} onClick={() => void decide(row)}>
              {row.trusted ? 'Отозвать разрешение' : 'Разрешить автопубликацию'}
            </button>
          )}
        </section>
      ))}
      {pages.length > 1 && (
        <button
          disabled={changing}
          onClick={() => {
            setRows(undefined);
            setError('');
            setPages((previous) => previous.slice(0, -1));
          }}
        >
          Предыдущая страница
        </button>
      )}
      {rows?.length === 100 && (
        <button
          disabled={changing}
          onClick={() => {
            setRows(undefined);
            setError('');
            setPages([...pages, rows[rows.length - 1]!.id]);
          }}
        >
          Следующая страница
        </button>
      )}
    </section>
  );
}
