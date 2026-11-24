'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/client';
import styles from './admin-feedback.module.css';

interface Suggestion {
  id: string;
  authorId: string;
  createdAt: string;
  message: string;
}
interface FeedbackPage {
  items: Suggestion[];
  nextCursor: string | null;
}

export default function AdminFeedback() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ cursor: string | null }>({
    cursor: null,
  });
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'error' | 'denied'
  >('loading');

  useEffect(() => {
    let active = true;
    const query = request.cursor
      ? '?cursor=' + encodeURIComponent(request.cursor)
      : '';
    api<FeedbackPage>('v1/admin/feedback' + query).then(
      (page) => {
        if (!active) return;
        setItems((current) =>
          request.cursor ? [...current, ...page.items] : page.items,
        );
        setNextCursor(page.nextCursor);
        setStatus('ready');
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          setItems([]);
          setNextCursor(null);
          setStatus('denied');
        } else {
          setStatus('error');
        }
      },
    );
    return () => {
      active = false;
    };
  }, [request]);

  function load(cursor: string | null) {
    setStatus('loading');
    setRequest({ cursor });
  }

  return (
    <>
      <h1>Предложения о портале</h1>
      <Link href="/account">В кабинет</Link>
      {items.length > 0 && (
        <ul className={styles.entries} aria-label="Предложения пользователей">
          {items.map((item) => (
            <li key={item.id} className="panel">
              <p className={styles.message}>{item.message}</p>
              <div className={styles.byline}>
                <span>ID пользователя {item.authorId}</span>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString('ru-RU')}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status === 'loading' && <p role="status">Загружаем предложения…</p>}
      {status === 'ready' && !items.length && <p>Предложений пока нет.</p>}
      {status === 'ready' && nextCursor && (
        <button type="button" onClick={() => load(nextCursor)}>
          Показать ещё
        </button>
      )}
      {status === 'error' && (
        <>
          <p role="alert">Не удалось загрузить предложения.</p>
          <button type="button" onClick={() => load(request.cursor)}>
            Повторить
          </button>
        </>
      )}
      {status === 'denied' && (
        <p role="alert">
          Для просмотра предложений нужен доступ администратора.
        </p>
      )}
    </>
  );
}
