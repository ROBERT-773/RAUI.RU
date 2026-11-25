'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/client';
import { feedbackIdentityEvent } from '../lib/feedback-draft';
import CabinetListingsTable from './cabinet-listings-table';
import styles from './admin-search.module.css';

type Kind = 'users' | 'listings';
type UserMatch = {
  id: string;
  publicId: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  matchedPhone: string | null;
};
type ListingMatch = {
  id: string;
  title: string;
  address: string;
  status: string;
  dealType: string;
  price: string | null;
  area: string | null;
  floor: string | null;
  sellerPublicId: string;
  publiclyVisible: boolean;
};
type Match = UserMatch | ListingMatch;
type Page = { items: Match[]; nextCursor: string | null };
const kinds = { users: 'Пользователи', listings: 'Объявления' } as const;
const roles: Record<string, string> = {
  buyer: 'Покупатель',
  owner: 'Собственник',
  agent: 'Агент',
  agency: 'Агентство',
  developer: 'Застройщик',
  moderator: 'Модератор',
  admin: 'Администратор',
  advertiser: 'Рекламодатель',
};
const denied = 'Для поиска нужен доступ администратора.';
const accessError = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);
async function adminIdentity() {
  const user = await api<{
    id: string;
    role: string;
    active: boolean;
    registration_approval_state: string;
  }>('v1/auth/me');
  return user?.id &&
    user.active !== false &&
    user.role === 'admin' &&
    user.registration_approval_state === 'approved'
    ? user.id
    : null;
}
type Session = {
  id: string | null;
  status: 'checking' | 'allowed' | 'denied' | 'error';
};

export default function AdminSearch() {
  const [session, setSession] = useState<Session>({
    id: null,
    status: 'checking',
  });
  const version = useRef(0);
  const verify = useCallback(async (clear = false) => {
    const request = ++version.current;
    setSession((old) => ({ id: clear ? null : old.id, status: 'checking' }));
    try {
      const id = await adminIdentity();
      if (version.current === request)
        setSession({ id, status: id ? 'allowed' : 'denied' });
    } catch (error) {
      if (version.current === request)
        setSession({
          id: null,
          status: accessError(error) ? 'denied' : 'error',
        });
    }
  }, []);
  useEffect(() => {
    const guard = version;
    const focused = () => void verify();
    const visibility = () => {
      if (document.visibilityState === 'visible') focused();
      else {
        version.current++;
        setSession((old) => ({ id: old.id, status: 'checking' }));
      }
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void verify(true);
    };
    const changed = (event: StorageEvent) => {
      if (event.key === feedbackIdentityEvent || event.key === null)
        void verify(true);
    };
    focused();
    window.addEventListener('focus', focused);
    window.addEventListener('pageshow', restored);
    window.addEventListener('storage', changed);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      guard.current++;
      window.removeEventListener('focus', focused);
      window.removeEventListener('pageshow', restored);
      window.removeEventListener('storage', changed);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [verify]);
  return (
    <>
      <Link href="/account">В кабинет</Link>
      <h1>Поиск пользователей и объявлений</h1>
      {session.status === 'checking' && (
        <p role="status">Проверяем доступ администратора…</p>
      )}
      {session.status === 'denied' && <p role="alert">{denied}</p>}
      {session.status === 'error' && (
        <p role="alert">Не удалось проверить доступ администратора.</p>
      )}
      {(session.status === 'denied' || session.status === 'error') && (
        <button type="button" onClick={() => void verify(true)}>
          Повторить проверку
        </button>
      )}
      {session.id && (
        <div hidden={session.status !== 'allowed'}>
          <SearchWorkspace
            key={session.id}
            actorId={session.id}
            onIdentity={(id) => {
              version.current++;
              setSession({ id, status: id ? 'allowed' : 'denied' });
            }}
          />
        </div>
      )}
    </>
  );
}

function SearchWorkspace({
  actorId,
  onIdentity,
}: {
  actorId: string;
  onIdentity: (id: string | null) => void;
}) {
  const [kind, setKind] = useState<Kind>('users');
  const [sellerId, setSellerId] = useState<string>();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Page>();
  const [status, setStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error' | 'invalid'
  >('idle');
  const [retryAfter, setRetryAfter] = useState<string>();
  const request = useRef(0);
  useEffect(() => {
    const guard = request;
    return () => {
      guard.current++;
    };
  }, []);
  function reset() {
    request.current++;
    setResult(undefined);
    setStatus('idle');
    setRetryAfter(undefined);
  }
  async function search(after?: string, seller = sellerId) {
    const term = seller ?? query.trim();
    const token = ++request.current;
    setRetryAfter(after);
    if (!after) setResult(undefined);
    if (
      !term ||
      term.length > 320 ||
      !/[\p{L}\p{N}]/u.test(term) ||
      term.includes('\0')
    ) {
      setStatus('invalid');
      return;
    }
    setStatus('loading');
    try {
      const next = await api<Page>(
        'v1/admin/search/' + (seller ? 'listings' : kind),
        'POST',
        {
          query: term,
          ...(seller ? { by: 'seller' } : {}),
          ...(after ? { after } : {}),
        },
      );
      if (token !== request.current) return;
      const current = await adminIdentity();
      if (token !== request.current) return;
      if (current !== actorId) {
        onIdentity(current);
        return;
      }
      setResult((previous) => ({
        items: after ? [...(previous?.items ?? []), ...next.items] : next.items,
        nextCursor: next.nextCursor,
      }));
      setStatus('ready');
    } catch (error) {
      if (token !== request.current) return;
      if (accessError(error)) {
        onIdentity(null);
        return;
      }
      setStatus(
        error instanceof ApiError && error.status === 400 ? 'invalid' : 'error',
      );
    }
  }
  const users = kind === 'users';
  function switchMode(next: Kind) {
    reset();
    setSellerId(undefined);
    setKind(next);
    setQuery('');
  }
  return (
    <div className={styles.workspace}>
      <div role="group" aria-label="Где искать" className={styles.mode}>
        {(['users', 'listings'] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={kind === key}
            onClick={() => {
              if (kind !== key || sellerId) switchMode(key);
            }}
          >
            {kinds[key]}
          </button>
        ))}
      </div>
      {sellerId ? (
        <section
          className={'panel ' + styles.search}
          aria-label="Выбранный автор"
        >
          <h2>Объявления пользователя №{sellerId}</h2>
          <button type="button" onClick={() => switchMode('listings')}>
            Искать другие объявления
          </button>
        </section>
      ) : (
        <form
          className={'panel ' + styles.search}
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label htmlFor="admin-search-query">
            {users ? 'Поиск пользователей' : 'Поиск объявлений'}
          </label>
          <p id="admin-search-hint">
            {users
              ? 'Введите ID, email, имя или полный номер телефона.'
              : 'Введите UUID объявления, заголовок или адрес.'}
          </p>
          <div className={styles.controls}>
            <input
              id="admin-search-query"
              value={query}
              maxLength={320}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={
                status === 'invalid'
                  ? 'admin-search-hint admin-search-invalid'
                  : 'admin-search-hint'
              }
              aria-invalid={status === 'invalid'}
              onChange={(e) => {
                reset();
                setQuery(e.target.value);
              }}
            />
            <button
              className="primary"
              type="submit"
              disabled={status === 'loading'}
            >
              Найти
            </button>
          </div>
          {status === 'invalid' && (
            <p id="admin-search-invalid" role="alert">
              Введите от 1 до 320 символов, включая хотя бы одну букву или
              цифру.
            </p>
          )}
        </form>
      )}
      <section aria-labelledby="admin-search-results">
        <h2 id="admin-search-results">Результаты поиска</h2>
        {status === 'loading' && <p role="status">Ищем…</p>}
        {status === 'ready' && !result?.items.length && (
          <p role="status">
            <strong>
              {users ? 'Пользователи не найдены.' : 'Объявления не найдены.'}
            </strong>{' '}
            Проверьте запрос или попробуйте другое значение.
          </p>
        )}
        {result && result.items.length > 0 && (
          <>
            <p role="status" className={styles.count}>
              Показано результатов: {result.items.length}.
            </p>
            {users ? (
              <ul className={styles.results}>
                {result.items
                  .filter((item): item is UserMatch => 'publicId' in item)
                  .map((item) => (
                    <li className="panel" key={item.id}>
                      <h3>{item.name}</h3>
                      <dl className={styles.facts}>
                        <dt>ID пользователя</dt>
                        <dd>{item.publicId}</dd>
                        <dt>Email</dt>
                        <dd>{item.email}</dd>
                        <dt>Роль</dt>
                        <dd>{roles[item.role] ?? item.role}</dd>
                        <dt>Аккаунт</dt>
                        <dd>{item.active ? 'Активен' : 'Отключён'}</dd>
                        {item.matchedPhone && (
                          <>
                            <dt>Найденный телефон</dt>
                            <dd>{item.matchedPhone}</dd>
                          </>
                        )}
                      </dl>
                      <button
                        type="button"
                        onClick={() => {
                          setKind('listings');
                          setQuery('');
                          setSellerId(item.publicId);
                          void search(undefined, item.publicId);
                        }}
                      >
                        Объявления пользователя
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <CabinetListingsTable
                label={
                  sellerId ? 'Объявления пользователя' : 'Найденные объявления'
                }
                rows={result.items
                  .filter(
                    (item): item is ListingMatch => 'sellerPublicId' in item,
                  )
                  .map((item) => ({
                    ...item,
                    object: (
                      <>
                        <h3>{item.title}</h3>
                        <p>{item.address}</p>
                        <details>
                          <summary>Идентификаторы</summary>
                          <dl className={styles.facts}>
                            <dt>ID автора</dt>
                            <dd>{item.sellerPublicId}</dd>
                            <dt>UUID объявления</dt>
                            <dd>{item.id}</dd>
                          </dl>
                        </details>
                        {item.publiclyVisible && (
                          <Link
                            href={'/listings/' + encodeURIComponent(item.id)}
                            prefetch={false}
                          >
                            Открыть объявление
                          </Link>
                        )}
                      </>
                    ),
                  }))}
              />
            )}
          </>
        )}
        {status === 'ready' && result?.nextCursor && (
          <button type="button" onClick={() => void search(result.nextCursor!)}>
            Показать ещё
          </button>
        )}
        {status === 'error' && (
          <>
            <p role="alert">Не удалось загрузить результаты поиска.</p>
            <button type="button" onClick={() => void search(retryAfter)}>
              Повторить
            </button>
          </>
        )}
      </section>
    </div>
  );
}
