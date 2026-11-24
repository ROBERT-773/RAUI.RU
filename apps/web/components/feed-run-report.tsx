import { useEffect, useState } from 'react';
import { api } from '../lib/client';

type Report = {
  id: string;
  status: 'running' | 'succeeded' | 'quarantined' | 'failed';
  stats: { total?: number; valid?: number; quarantined?: number };
  error: string | null;
};
type Rejected = { external_reference: string; errors: { message: string }[] };
const failureHints = new Map([
  [
    'source_changed',
    'Ссылка изменилась. Запустите проверку для нового адреса.',
  ],
  [
    'access_revoked',
    'Доступ к источнику отозван. Обратитесь к администратору.',
  ],
  [
    'invalid_feed',
    'Не удалось прочитать XML. Проверьте файл и выбранный формат.',
  ],
  [
    'source_unavailable',
    'Источник недоступен. Проверьте ссылку или повторите попытку позже.',
  ],
]);

function RejectedRows({ path, total }: { path: string; total: number }) {
  const [rows, setRows] = useState<Rejected[]>([]);
  const [after, setAfter] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [end, setEnd] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    const q = new URLSearchParams({ errorsOnly: 'true', limit: '20' });
    if (after) q.set('after', after);
    api<Rejected[]>(path + '/items?' + q.toString())
      .then((page) => {
        if (!current) return;
        setRows((previous) => (after ? [...previous, ...page] : page));
        setEnd(page.length < 20);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [after, path, retry]);
  return (
    <>
      {rows.length > 0 && (
        <ul className="feed-errors">
          {rows.map((row) => (
            <li key={row.external_reference}>
              <strong>{row.external_reference}</strong> ·{' '}
              {row.errors.map((e) => e.message).join('. ') ||
                'Проверьте данные объявления.'}
            </li>
          ))}
        </ul>
      )}
      {busy && <p role="status">Загружаем ошибки…</p>}
      {error && (
        <p role="alert">
          Не удалось загрузить ошибки.{' '}
          <button
            onClick={() => {
              setBusy(true);
              setError(false);
              setRetry(retry + 1);
            }}
          >
            Повторить
          </button>
        </p>
      )}
      {!error && !busy && !end && rows.length > 0 && rows.length < total && (
        <button
          onClick={() => {
            setBusy(true);
            setAfter(rows[rows.length - 1]!.external_reference);
          }}
        >
          Ещё ошибки
        </button>
      )}
    </>
  );
}

export default function FeedRunReport({ path }: { path: string }) {
  const [report, setReport] = useState<Report>();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState(false);
  const [showRows, setShowRows] = useState(false);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<Report>(path);
        if (!current) return;
        setReport(next);
        if (next.status === 'running')
          timer = setTimeout(() => void refresh(), 3000);
      } catch {
        if (current) setError(true);
      }
    }
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [path, retry]);
  if (error)
    return (
      <p role="alert">
        Отчёт сейчас недоступен.{' '}
        <button
          onClick={() => {
            setError(false);
            setRetry(retry + 1);
          }}
        >
          Обновить отчёт
        </button>
      </p>
    );
  if (!report || report.status === 'running')
    return <p role="status">Проверка в очереди или выполняется…</p>;
  if (report.status === 'failed')
    return (
      <p role="alert">
        {failureHints.get(report.error ?? '') ??
          'Проверка не завершилась. Проверьте доступ к XML-файлу и его формат.'}
      </p>
    );
  const { total, valid, quarantined } = report.stats;
  return (
    <>
      <p role="status">
        Проверено объектов — {total}. Прошли проверку — {valid}. С ошибками —{' '}
        {quarantined}.
      </p>
      {Boolean(quarantined) && (
        <>
          <button
            type="button"
            aria-expanded={showRows}
            onClick={() => setShowRows(!showRows)}
          >
            {showRows ? 'Скрыть ошибки' : 'Посмотреть ошибки'}
          </button>
          {showRows && <RejectedRows path={path} total={quarantined!} />}
        </>
      )}
    </>
  );
}
