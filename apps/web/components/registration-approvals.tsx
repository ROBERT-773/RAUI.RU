'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
type Applicant = {
  id: string;
  user_id: string;
  public_id: string;
  display_name: string;
  role: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  requested_at: string;
};
type Details = Applicant & {
  email: string;
  phone: string | null;
  state: string;
  reason: string | null;
  resolved_at: string | null;
};
type Queue = { items: Applicant[]; cursor: string | null };
type Action = {
  id: string;
  decision: 'approve' | 'reject';
  reason: string;
  key: string;
};
const route = 'v1/admin/registration-approvals';
export default function RegistrationApprovals() {
  const [queue, setQueue] = useState<Queue>({ items: [], cursor: null });
  const [details, setDetails] = useState<Details>();
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<Action>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const live = useRef(false);
  const generation = useRef(0);
  const queueGeneration = useRef(0);
  useEffect(() => {
    live.current = true;
    const detailRequests = generation;
    const queueRequests = queueGeneration;
    const current = ++queueGeneration.current;
    api<Queue>(route)
      .then((value) => {
        if (live.current && current === queueGeneration.current)
          setQueue(value);
      })
      .catch(() => {
        if (live.current && current === queueGeneration.current)
          setError(
            'Не удалось загрузить заявки. Проверьте доступ и повторите запрос.',
          );
      })
      .finally(() => {
        if (live.current && current === queueGeneration.current)
          setLoading(false);
      });
    return () => {
      live.current = false;
      detailRequests.current++;
      queueRequests.current++;
    };
  }, []);
  async function loadQueue(append = false) {
    if (busy || loading) return;
    const cursor = append ? queue.cursor : null;
    if (append && !cursor) return;
    const current = ++queueGeneration.current;
    if (!append) {
      generation.current++;
      setDetails(undefined);
      setAction(undefined);
      setReason('');
    }
    setLoading(true);
    setError('');
    try {
      const value = await api<Queue>(
        cursor ? `${route}?after=${encodeURIComponent(cursor)}` : route,
      );
      if (live.current && current === queueGeneration.current)
        setQueue((previous) => ({
          items: append ? [...previous.items, ...value.items] : value.items,
          cursor: value.cursor,
        }));
    } catch {
      if (live.current && current === queueGeneration.current) {
        if (!append) setQueue({ items: [], cursor: null });
        setError(
          'Не удалось загрузить заявки. Проверьте доступ и повторите запрос.',
        );
      }
    } finally {
      if (live.current && current === queueGeneration.current)
        setLoading(false);
    }
  }
  async function open(item: Applicant) {
    if (busy) return;
    const current = ++generation.current;
    setDetails(undefined);
    setAction(undefined);
    setReason('');
    setError('');
    setNotice('');
    try {
      const value = await api<Details>(`${route}/${item.id}`);
      if (live.current && current === generation.current) {
        if (value.id !== item.id || value.user_id !== item.user_id)
          throw new Error('Stale');
        setDetails(value);
      }
    } catch {
      if (live.current && current === generation.current)
        setError('Заявка недоступна или изменилась. Обновите очередь.');
    }
  }
  const validReason = reason.trim().length >= 3 && reason.trim().length <= 2000;
  const verified = !!details?.email_verified_at && !!details?.phone_verified_at;
  function prepare(decision: Action['decision']) {
    if (
      !details ||
      details.state !== 'pending' ||
      !validReason ||
      busy ||
      action ||
      (decision === 'approve' && !verified)
    )
      return;
    setError('');
    setAction({
      id: details.id,
      decision,
      reason: reason.trim(),
      key: crypto.randomUUID(),
    });
  }
  async function confirm() {
    if (!action || busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ id: string; user_id: string; state: string }>(
        `${route}/${action.id}/decision`,
        'POST',
        { decision: action.decision, reason: action.reason },
        { idempotencyKey: action.key },
      );
      if (!live.current || current !== generation.current) return;
      if (
        result.id !== action.id ||
        result.user_id !== details?.user_id ||
        result.state !==
          (action.decision === 'approve' ? 'approved' : 'rejected')
      )
        throw new Error('Unexpected decision');
      setDetails(undefined);
      setAction(undefined);
      setReason('');
      setNotice('Решение сохранено.');
      const request = ++queueGeneration.current;
      try {
        const value = await api<Queue>(route);
        if (
          live.current &&
          current === generation.current &&
          request === queueGeneration.current
        )
          setQueue(value);
      } catch {
        if (live.current && current === generation.current) {
          setQueue({ items: [], cursor: null });
          setError(
            'Решение сохранено, но очередь не обновилась. Повторите загрузку очереди.',
          );
        }
      }
    } catch {
      if (live.current && current === generation.current)
        setError(
          'Решение не подтверждено сервером. Проверьте доступ или повторите запрос.',
        );
    } finally {
      if (live.current && current === generation.current) setBusy(false);
    }
  }
  return (
    <section>
      <h1>Заявки на регистрацию</h1>
      <p>
        Новые заявки появляются в этой очереди. Одобрение не заменяет
        подтверждение контактов.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Загрузка…</p>}
      <button disabled={busy || loading} onClick={() => void loadQueue()}>
        Обновить очередь
      </button>
      {!loading && !error && queue.items.length === 0 && (
        <p>Нет ожидающих заявок.</p>
      )}
      <ul>
        {queue.items.map((item) => (
          <li key={item.id}>
            <button disabled={busy} onClick={() => void open(item)}>
              Открыть заявку {item.display_name} — ID {item.public_id}
            </button>
            <p>Дата заявки: {item.requested_at}</p>
          </li>
        ))}
      </ul>
      {queue.cursor && (
        <button disabled={busy || loading} onClick={() => void loadQueue(true)}>
          Загрузить ещё заявки
        </button>
      )}
      {details && (
        <article>
          <h2>
            {details.display_name} — ID {details.public_id}
          </h2>
          <p>{details.email}</p>
          <p>{details.phone ?? 'Телефон не указан'}</p>
          <p>
            Email:{' '}
            {details.email_verified_at ? 'подтверждён' : 'не подтверждён'}.
            Телефон:{' '}
            {details.phone_verified_at ? 'подтверждён' : 'не подтверждён'}.
          </p>
          {details.state === 'pending' ? (
            <>
              <label>
                Причина решения
                <textarea
                  minLength={3}
                  maxLength={2000}
                  value={reason}
                  disabled={busy || !!action}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                disabled={busy || !!action || !validReason || !verified}
                onClick={() => prepare('approve')}
              >
                Одобрить
              </button>
              <button
                disabled={busy || !!action || !validReason}
                onClick={() => prepare('reject')}
              >
                Отклонить
              </button>
              {action && (
                <div role="group" aria-label="Подтверждение решения">
                  <p>
                    {action.decision === 'approve'
                      ? 'Одобрить регистрацию?'
                      : 'Отклонить регистрацию?'}{' '}
                    {action.reason}
                  </p>
                  <button disabled={busy} onClick={() => void confirm()}>
                    Подтвердить решение
                  </button>
                  <button disabled={busy} onClick={() => setAction(undefined)}>
                    Отмена
                  </button>
                </div>
              )}
            </>
          ) : (
            <p>Заявка уже рассмотрена. {details.reason}</p>
          )}
        </article>
      )}
    </section>
  );
}
