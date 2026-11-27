'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/client';
import { supportTopics, type SupportTicket } from '../lib/support';

export default function AdminSupport() {
  const [request, setRequest] = useState({ topic: '', cursor: '' });
  const { topic, cursor } = request;
  const [items, setItems] = useState<SupportTicket[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'error' | 'denied'
  >('loading');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams();
    if (request.topic) query.set('topic', request.topic);
    if (request.cursor) query.set('after', request.cursor);
    api<{ items: SupportTicket[]; nextCursor: string | null }>(
      'v1/admin/support?' + query,
    ).then(
      (page) => {
        if (active) {
          setItems(page.items);
          setNext(page.nextCursor);
          setStatus('ready');
        }
      },
      (err) => {
        if (active)
          setStatus(
            err instanceof ApiError && [401, 403].includes(err.status)
              ? 'denied'
              : 'error',
          );
      },
    );
    return () => {
      active = false;
    };
  }, [request]);
  function load(topic: string, cursor: string) {
    setItems([]);
    setNext(null);
    setNotice('');
    setStatus('loading');
    setRequest({ topic, cursor });
  }
  return (
    <>
      <h1>Обращения в поддержку</h1>
      <Link href="/account">В кабинет</Link>
      <label>
        Тема обращения
        <select value={topic} onChange={(e) => load(e.target.value, '')}>
          <option value="">Все темы</option>
          {Object.entries(supportTopics).map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {notice && <p role="status">{notice}</p>}
      {status === 'loading' && <p role="status">Загружаем очередь…</p>}
      {status === 'denied' && (
        <p role="alert">Для просмотра нужен доступ администратора.</p>
      )}
      {status === 'error' && <p role="alert">Не удалось загрузить очередь.</p>}
      {status === 'ready' && !items.length && (
        <p>В этой очереди обращений нет.</p>
      )}
      {items.map((row) => (
        <Answer
          key={row.id}
          ticket={row}
          done={(msg) => {
            setNotice(msg);
            setItems((list) => list.filter((it) => it.id !== row.id));
          }}
        />
      ))}
      {next && (
        <button onClick={() => load(topic, next)}>Следующие обращения</button>
      )}
      {cursor && (
        <button onClick={() => load(topic, '')}>В начало очереди</button>
      )}
      {status !== 'denied' && status !== 'loading' && (
        <button onClick={() => load(topic, cursor)}>Обновить очередь</button>
      )}
    </>
  );
}
function Answer({
  ticket,
  done,
}: {
  ticket: SupportTicket;
  done: (message: string) => void;
}) {
  const [reply, setReply] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="panel">
      <h2>{supportTopics[ticket.topic]}</h2>
      <time dateTime={ticket.createdAt}>
        {new Date(ticket.createdAt).toLocaleString('ru-RU')}
      </time>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {ticket.message}
      </p>
      {ticket.listingId && (
        <Link href={'/listings/' + ticket.listingId}>Открыть объявление</Link>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !reply.trim()) return;
          setBusy(true);
          setError('');
          try {
            await api('v1/admin/support/' + ticket.id + '/reply', 'POST', {
              reply: reply.trim(),
            });
            done('Ответ сохранён и доступен автору обращения.');
          } catch (err) {
            if (err instanceof ApiError && err.status === 409)
              done('Другой сотрудник уже ответил на это обращение.');
            else setError('Не удалось сохранить ответ. Попробуйте ещё раз.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Ответ автору
          <textarea
            required
            rows={3}
            maxLength={2000}
            disabled={busy}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={busy || !reply.trim()}>
          {busy ? 'Сохраняем…' : 'Ответить'}
        </button>
      </form>
    </section>
  );
}
