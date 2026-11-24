'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/client';
import FeedRunReport, { feedProviders as sources } from './feed-run-report';
type Provider = keyof typeof sources;
type Source = {
  id: string;
  provider: Provider;
  host: string;
  active: boolean;
  trusted: boolean;
  lastRunId: string | null;
  lastApplyRunId: string | null;
};
type Submitted = {
  feed: Omit<Source, 'lastRunId'>;
  preview: { runId: string };
};

function SourceRow({
  base,
  provider,
  saved,
}: {
  base: string;
  provider: Provider;
  saved: Source | undefined;
}) {
  const label = sources[provider];
  const inputId = useId();
  const [source, setSource] = useState(saved);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ url: string; key: string } | null>(null);
  const submitting = useRef(false);
  async function refreshReports() {
    if (submitting.current) return;
    submitting.current = true;
    setRefreshing(true);
    setError('');
    try {
      const links = await api<Source[]>(base + '/links');
      setSource(links.find((row) => row.provider === provider));
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        setSource(undefined);
        setUrl('');
        setError('Доступ к источнику закрыт.');
      } else setError('Не удалось обновить отчёты. Попробуйте ещё раз.');
    } finally {
      submitting.current = false;
      setRefreshing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const value = url.trim();
    if (value) {
      try {
        const candidate = new URL(value);
        if (
          candidate.protocol !== 'https:' ||
          candidate.username ||
          candidate.password ||
          candidate.hash
        )
          throw new Error();
      } catch {
        setError('Введите ссылку HTTPS на XML-файл.');
        return;
      }
    } else if (!source) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    if (request.current?.url !== value)
      request.current = { url: value, key: crypto.randomUUID() };
    try {
      const { feed, preview } = await api<Submitted>(
        base + '/link',
        'POST',
        { provider, ...(value ? { url: value } : {}) },
        { idempotencyKey: request.current.key },
      );
      request.current = null;
      setSource({ ...feed, lastRunId: preview.runId });
      setUrl('');
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? e.message
          : e instanceof ApiError && e.status === 403
            ? 'Для настройки выгрузки нужны права управления.'
            : 'Не удалось запустить проверку. Попробуйте ещё раз.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="feed-row" aria-label={label}>
      <form onSubmit={submit}>
        <label htmlFor={inputId}>{label}</label>
        {source && (
          <small>
            {source.active ? 'Ссылка сохранена' : 'Источник отключён'} ·{' '}
            {source.host}
            {source.active &&
              (source.trusted
                ? ' · Автопубликация разрешена'
                : ' · Без автопубликации')}
          </small>
        )}
        <div className="feed-controls">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            placeholder={
              source ? 'Новая ссылка для замены' : 'Ссылка на XML-выгрузку'
            }
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError('');
            }}
            disabled={busy || refreshing || source?.active === false}
            required={!source}
          />
          <button
            disabled={
              busy ||
              refreshing ||
              source?.active === false ||
              (!url.trim() && !source)
            }
          >
            {busy
              ? 'Отправляем…'
              : source && !url.trim()
                ? 'Проверить ещё раз'
                : 'Проверить'}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
      {source && (
        <button
          type="button"
          disabled={busy || refreshing}
          onClick={() => void refreshReports()}
        >
          {refreshing ? 'Обновляем отчёты…' : 'Обновить отчёты'}
        </button>
      )}
      {source?.lastRunId && (
        <div role="group" aria-label="Последняя проверка">
          <strong>Последняя проверка</strong>
          <FeedRunReport
            key={source.lastRunId}
            path={base + '/' + source.id + '/runs/' + source.lastRunId}
          />
        </div>
      )}
      {source?.lastApplyRunId && (
        <div role="group" aria-label="Последний импорт">
          <strong>Последний импорт</strong>
          <FeedRunReport
            key={source.lastApplyRunId}
            kind="apply"
            path={base + '/' + source.id + '/runs/' + source.lastApplyRunId}
          />
        </div>
      )}
    </section>
  );
}

function Sources({ base }: { base: string }) {
  const [rows, setRows] = useState<Source[]>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    api<Source[]>(base + '/links')
      .then((value) => {
        if (!Array.isArray(value)) throw new Error();
        if (current) setRows(value);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [base, retry]);
  if (error)
    return (
      <div role="alert">
        Не удалось загрузить источники.{' '}
        <button
          onClick={() => {
            setError(false);
            setRetry(retry + 1);
          }}
        >
          Повторить
        </button>
      </div>
    );
  if (!rows) return <p role="status">Загружаем источники…</p>;
  return (
    <>
      {(Object.keys(sources) as Provider[]).map((provider) => (
        <SourceRow
          key={provider}
          base={base}
          provider={provider}
          saved={rows.find((row) => row.provider === provider)}
        />
      ))}
    </>
  );
}

export default function ProfessionalFeedLinks({
  organizationId,
  onVerifyContacts,
}: {
  organizationId?: string;
  onVerifyContacts?: (() => void) | undefined;
}) {
  const base = organizationId
    ? 'v1/organizations/' + organizationId + '/feeds'
    : 'v1/account/feeds';
  const [open, setOpen] = useState(false);
  return (
    <details
      className="feed-import"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {organizationId ? 'XML-выгрузки организации' : 'Мои XML-выгрузки'}
      </summary>
      {open &&
        (onVerifyContacts ? (
          <button onClick={onVerifyContacts}>
            Подтвердить почту и телефон для импорта
          </button>
        ) : (
          <Sources key={base} base={base} />
        ))}
    </details>
  );
}
