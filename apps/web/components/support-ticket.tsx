'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/client';
import {
  isSupportTopic,
  supportTopics,
  supportUuid,
  type SupportTicket,
  type SupportTopic,
} from '../lib/support';

export function NewSupportTicket({
  initialTopic,
  listingId,
  articles,
}: {
  initialTopic: SupportTopic;
  listingId?: string | undefined;
  articles: {
    title: string;
    answer: string;
    keywords: string;
    action?: { label: string; href: string };
  }[];
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState('');
  const request = useRef<{ body: string; receipt: string } | null>(null);
  const sending = useRef(false);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const hints: Partial<Record<SupportTopic, string>> = {
    login: 'вход',
    listing: 'адрес',
    moderation: 'модерация',
    photos: 'фото',
    xml: 'фид',
    complaint: 'контакты',
  };
  const hint = hints[topic];
  const related = hint
    ? articles.filter((a) => a.keywords.includes(hint)).slice(0, 2)
    : [];
  useEffect(() => {
    if (accepted) confirmation.current?.focus();
  }, [accepted]);

  if (accepted)
    return (
      <section className="panel">
        <h2 ref={confirmation} tabIndex={-1}>
          Обращение принято
        </h2>
        <p>
          Сохраните личную ссылку. По ней можно прочитать ответ поддержки на
          любом устройстве.
        </p>
        <p>
          <a href={'/support/status#' + accepted}>Открыть моё обращение</a>
        </p>
        <label>
          Личная ссылка
          <input
            readOnly
            value={window.location.origin + '/support/status#' + accepted}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      </section>
    );
  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        if (sending.current || !message.trim()) return;
        sending.current = true;
        setBusy(true);
        setError('');
        try {
          const payload = {
            topic,
            message: message.trim(),
            ...(listingId ? { listingId } : {}),
          };
          const body = JSON.stringify(payload);
          if (request.current?.body !== body)
            request.current = { body, receipt: crypto.randomUUID() };
          const receipt = request.current.receipt;
          await api('v1/support/tickets', 'POST', { ...payload, receipt });
          setAccepted(receipt);
        } catch (err) {
          setError(
            err instanceof ApiError && err.status === 429
              ? 'Слишком много обращений. Попробуйте через минуту.'
              : 'Не удалось подтвердить отправку. Текст сохранён в форме, попробуйте ещё раз.',
          );
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <label>
        Тема обращения
        <select
          value={topic}
          disabled={busy}
          onChange={(e) => {
            if (isSupportTopic(e.target.value)) setTopic(e.target.value);
          }}
        >
          {Object.entries(supportTopics).map(([key, name]) => (
            <option value={key} key={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {related.map((a) => (
        <details key={a.title}>
          <summary>{a.title}</summary>
          <p>{a.answer}</p>
          {a.action && <Link href={a.action.href}>{a.action.label}</Link>}
        </details>
      ))}
      {listingId && (
        <p>
          К обращению прикреплено{' '}
          <Link href={'/listings/' + listingId}>объявление</Link>.
        </p>
      )}
      <label>
        Сообщение
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          maxLength={2000}
          required
          disabled={busy}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={busy || !message.trim()}>
        {busy ? 'Отправляем…' : 'Отправить обращение'}
      </button>
    </form>
  );
}

export function TicketStatus() {
  const [request, setRequest] = useState(0);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'missing' | 'error'
  >('loading');
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const load = async () => {
      const seq = ++sequence;
      const key = window.location.hash.slice(1);
      setTicket(null);
      if (!supportUuid.test(key)) {
        setStatus('missing');
        return;
      }
      setStatus('loading');
      try {
        const row = await api<SupportTicket>(
          'v1/support/tickets/status',
          'POST',
          { receipt: key },
        );
        if (active && seq === sequence) {
          setTicket(row);
          setStatus('ready');
        }
      } catch (err) {
        if (active && seq === sequence)
          setStatus(
            err instanceof ApiError && [400, 404].includes(err.status)
              ? 'missing'
              : 'error',
          );
      }
    };
    void load();
    window.addEventListener('hashchange', load);
    return () => {
      active = false;
      window.removeEventListener('hashchange', load);
    };
  }, [request]);
  return (
    <section className="panel">
      {status === 'loading' && <p role="status">Проверяем обращение…</p>}
      {status === 'missing' && (
        <p role="alert">
          Обращение не найдено. Откройте полную личную ссылку, которую вы
          сохранили после отправки.
        </p>
      )}
      {status === 'error' && (
        <p role="alert">Не удалось проверить ответ. Попробуйте ещё раз.</p>
      )}
      {ticket && (
        <>
          <h2>{supportTopics[ticket.topic]}</h2>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {ticket.message}
          </p>
          <h3>Ответ поддержки</h3>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {ticket.reply ?? 'Обращение в очереди. Ответ появится здесь.'}
          </p>
        </>
      )}
      {(status === 'error' || (status === 'ready' && !ticket?.reply)) && (
        <button type="button" onClick={() => setRequest((n) => n + 1)}>
          Проверить ответ
        </button>
      )}
    </section>
  );
}
