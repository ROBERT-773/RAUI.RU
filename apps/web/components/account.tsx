'use client';
import { Button } from '@raui/ui';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ListingCard, SearchDefinition } from '@raui/types/product';
import { api, setCsrf, track } from '../lib/client';
import { attributeLabels } from '../lib/labels';
import { Card } from './card';
import AccountProfile from './account-profile';
interface AccountUser {
  display_name: string;
  public_id: string;
  registration_approval_state?: 'pending' | 'approved' | 'rejected';
  registration_approval_reason?: string | null;
}
const sessionExpired = (error: unknown) =>
  error instanceof Error && 'status' in error && error.status === 401;
const approved = (user: AccountUser) =>
  !user.registration_approval_state ||
  user.registration_approval_state === 'approved';
type Tab =
  'favorite' | 'compare' | 'recent' | 'saved' | 'messages' | 'notifications';
interface Saved {
  id: string;
  name: string;
  definition: SearchDefinition;
}
interface Thread {
  id: string;
  listing_id: string;
}
interface Message {
  id: string;
  body: string;
  created_at: string;
}
interface Notification {
  id: string;
  thread_id: string;
  read_at: string | null;
}
export default function Account() {
  const [user, setUser] = useState<AccountUser | null>(null),
    [profileOpen, setProfileOpen] = useState(false),
    [checking, setChecking] = useState(true),
    [tab, setTab] = useState<Tab>('favorite'),
    [notice, setNotice] = useState(''),
    [register, setRegister] = useState(false),
    [items, setItems] = useState<ListingCard[]>([]),
    [saved, setSaved] = useState<Saved[]>([]),
    [threads, setThreads] = useState<Thread[]>([]),
    [notifications, setNotifications] = useState<Notification[]>([]),
    [activeThread, setActiveThread] = useState(''),
    [messages, setMessages] = useState<Message[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [messageCursor, setMessageCursor] = useState<string | null>(null),
    [notificationEnabled, setNotificationEnabled] = useState(true);
  const identityEpoch = useRef(0);
  const collectionRequest = useRef(0);
  const navigationEpoch = useRef(0);
  const threadRequest = useRef(0);
  const profileRequest = useRef(0);
  function selectTab(next: Tab) {
    const navigation = ++navigationEpoch.current;
    threadRequest.current++;
    setTab(next);
    setItems([]);
    setCursor(null);
    setActiveThread('');
    setMessages([]);
    setMessageCursor(null);
    return navigation;
  }
  function clearPrivateState() {
    const epoch = ++identityEpoch.current;
    setTab('favorite');
    setProfileOpen(false);
    setNotice('');
    setRegister(false);
    setItems([]);
    setSaved([]);
    setThreads([]);
    setNotifications([]);
    setActiveThread('');
    setMessages([]);
    setCursor(null);
    setMessageCursor(null);
    setNotificationEnabled(true);
    return epoch;
  }
  useEffect(() => {
    const epochRef = identityEpoch;
    const epoch = identityEpoch.current;
    api<AccountUser>('v1/auth/me')
      .then((u) => {
        if (epoch !== identityEpoch.current) return;
        setUser(u);
        if (approved(u)) void load('favorite');
      })
      .catch(() => {})
      .finally(() => {
        if (epoch === identityEpoch.current) setChecking(false);
      });
    return () => {
      epochRef.current++;
    };
  }, []);
  async function load(t: Tab, after?: string) {
    const epoch = identityEpoch.current;
    const request = ++collectionRequest.current;
    try {
      if (['favorite', 'compare', 'recent'].includes(t)) {
        const r = await api<{ items: ListingCard[]; cursor: string | null }>(
          'v1/account/collections/' + t + (after ? '?after=' + after : ''),
        );
        if (
          epoch !== identityEpoch.current ||
          request !== collectionRequest.current
        )
          return;
        setItems((previous) => (after ? [...previous, ...r.items] : r.items));
        setCursor(r.cursor);
      } else if (t === 'saved') {
        const r = await api<{ items: Saved[]; cursor: string | null }>(
          'v1/account/saved-searches' + (after ? '?after=' + after : ''),
        );
        if (
          epoch !== identityEpoch.current ||
          request !== collectionRequest.current
        )
          return;
        setSaved((previous) => (after ? [...previous, ...r.items] : r.items));
        setCursor(r.cursor);
      } else if (t === 'messages') {
        const r = await api<{ items: Thread[]; cursor: string | null }>(
          'v1/account/threads' + (after ? '?after=' + after : ''),
        );
        if (
          epoch !== identityEpoch.current ||
          request !== collectionRequest.current
        )
          return;
        setThreads((previous) => (after ? [...previous, ...r.items] : r.items));
        setCursor(r.cursor);
      } else {
        const r = await api<{ items: Notification[]; cursor: string | null }>(
          'v1/account/notifications' + (after ? '?cursor=' + after : ''),
        );
        if (
          epoch !== identityEpoch.current ||
          request !== collectionRequest.current
        )
          return;
        const prefs = await api<{ in_app: boolean }>('v1/account/preferences');
        if (
          epoch !== identityEpoch.current ||
          request !== collectionRequest.current
        )
          return;
        setNotificationEnabled(prefs.in_app);
        setNotifications((previous) =>
          after ? [...previous, ...r.items] : r.items,
        );
        setCursor(r.cursor);
      }
    } catch (e) {
      if (
        epoch !== identityEpoch.current ||
        request !== collectionRequest.current
      )
        return;
      setNotice((e as Error).message);
    }
  }
  async function openThread(id: string, after?: string) {
    const epoch = identityEpoch.current;
    const navigation = navigationEpoch.current;
    const request = ++threadRequest.current;
    if (!after) {
      setActiveThread(id);
      setMessages([]);
      setMessageCursor(null);
    }
    try {
      const r = await api<{ items: Message[]; cursor: string | null }>(
        'v1/account/threads/' +
          id +
          '/messages' +
          (after ? '?cursor=' + after : ''),
      );
      if (
        epoch !== identityEpoch.current ||
        navigation !== navigationEpoch.current ||
        request !== threadRequest.current
      )
        return false;
      setActiveThread(id);
      setMessages((previous) => (after ? [...previous, ...r.items] : r.items));
      setMessageCursor(r.cursor);
      return true;
    } catch (e) {
      if (
        epoch !== identityEpoch.current ||
        navigation !== navigationEpoch.current ||
        request !== threadRequest.current
      )
        return false;
      setNotice((e as Error).message);
      return false;
    }
  }
  function expireIdentity(epoch: number) {
    if (epoch !== identityEpoch.current) return;
    clearPrivateState();
    setCsrf('');
    setUser(null);
    setNotice('Войдите в аккаунт, чтобы продолжить.');
  }
  async function refreshProfile() {
    const epoch = identityEpoch.current;
    const request = ++profileRequest.current;
    try {
      const current = await api<AccountUser>('v1/auth/me');
      if (epoch !== identityEpoch.current || request !== profileRequest.current)
        return;
      collectionRequest.current++;
      navigationEpoch.current++;
      threadRequest.current++;
      setUser(current);
      setItems([]);
      setSaved([]);
      setThreads([]);
      setNotifications([]);
      setActiveThread('');
      setMessages([]);
      setCursor(null);
      setMessageCursor(null);
      if (approved(current)) void load(tab);
    } catch (error) {
      if (epoch !== identityEpoch.current || request !== profileRequest.current)
        return;
      if (sessionExpired(error)) expireIdentity(epoch);
      else setNotice((error as Error).message);
    }
  }
  if (checking) return <p role="status">Проверяем аккаунт…</p>;
  if (!user)
    return (
      <>
        <h1>{register ? 'Создать аккаунт' : 'Войти в аккаунт'}</h1>
        <form
          className="account-form panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const epoch = identityEpoch.current;
            const d = new FormData(e.currentTarget);
            try {
              let deliveryUnavailable = false;
              if (register) {
                const created = await api<{
                  verificationDelivery?: 'accepted' | 'unavailable';
                }>('v1/auth/register', 'POST', {
                  email: d.get('email'),
                  password: d.get('password'),
                  displayName: d.get('name'),
                  role: d.get('role'),
                });
                deliveryUnavailable =
                  created.verificationDelivery === 'unavailable';
              }
              if (epoch !== identityEpoch.current) return;
              const result = await api<{
                csrfToken: string;
                user: AccountUser;
              }>('v1/auth/login', 'POST', {
                email: d.get('email'),
                password: d.get('password'),
                transport: 'cookie',
              });
              if (epoch !== identityEpoch.current) return;
              clearPrivateState();
              setCsrf(result.csrfToken);
              setUser(result.user);
              if (deliveryUnavailable)
                setNotice(
                  'Аккаунт создан. Не удалось подтвердить отправку письма. Запросите письмо повторно в профиле.',
                );
              if (approved(result.user)) void load('favorite');
            } catch (error) {
              if (epoch !== identityEpoch.current) return;
              setNotice((error as Error).message);
            }
          }}
        >
          {register && (
            <>
              <label>
                Тип аккаунта
                <select name="role" defaultValue="buyer">
                  <option value="buyer">Покупатель или арендатор</option>
                  <option value="owner">Собственник</option>
                </select>
              </label>
              <label>
                Имя
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
              </label>
            </>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Пароль
            <input
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              minLength={12}
              required
            />
          </label>
          <Button className="primary" type="submit">
            {register ? 'Создать и войти' : 'Войти'}
          </Button>
        </form>
        {!register && (
          <p>
            <Link href="/account/forgot-password">Забыли пароль?</Link>
          </p>
        )}
        <Button onClick={() => setRegister(!register)}>
          {register ? 'Уже есть аккаунт' : 'Регистрация'}
        </Button>
        {notice && <p role="alert">{notice}</p>}
      </>
    );
  const logoutButton = (
    <Button
      onClick={async () => {
        const epoch = clearPrivateState();
        try {
          await api('v1/auth/logout', 'POST');
          if (epoch !== identityEpoch.current) return;
          clearPrivateState();
          setCsrf('');
          setUser(null);
        } catch (e) {
          if (epoch !== identityEpoch.current) return;
          if (sessionExpired(e)) expireIdentity(epoch);
          else setNotice((e as Error).message);
        }
      }}
    >
      Выйти
    </Button>
  );
  const profileEpoch = identityEpoch.current;
  if (!approved(user) || profileOpen)
    return (
      <>
        <h1>Мой аккаунт</h1>
        <p>{user.display_name}</p>
        <p>ID: {user.public_id}</p>
        {logoutButton}
        {approved(user) && (
          <Button onClick={() => setProfileOpen(false)}>
            Вернуться к разделам аккаунта
          </Button>
        )}
        {notice && <p role="status">{notice}</p>}
        <AccountProfile
          key={identityEpoch.current}
          onRefresh={refreshProfile}
          onSessionExpired={() => expireIdentity(profileEpoch)}
        />
      </>
    );
  return (
    <>
      <h1>Мой аккаунт</h1>
      <p>{user.display_name}</p>
      <p>ID: {user.public_id}</p>
      <Link href="/account/listings">Мои объявления</Link>
      {logoutButton}
      <Button onClick={() => setProfileOpen(true)}>
        Профиль и подтверждение контактов
      </Button>
      <nav className="toolbar" aria-label="Разделы аккаунта">
        {(
          [
            ['favorite', 'Избранное'],
            ['compare', 'Сравнение'],
            ['recent', 'История'],
            ['saved', 'Сохранённые поиски'],
            ['messages', 'Сообщения'],
            ['notifications', 'Уведомления'],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            aria-pressed={tab === key}
            onClick={() => {
              selectTab(key);
              void load(key);
            }}
          >
            {label}
          </Button>
        ))}
      </nav>
      {notice && <p role="status">{notice}</p>}
      {['favorite', 'compare', 'recent'].includes(tab) && (
        <>
          {items.length === 0 ? (
            <p>Здесь пока нет объявлений.</p>
          ) : (
            <div className="cards">
              {items.map((item) => (
                <Card
                  key={item.id}
                  listing={item}
                  actions={
                    <Button
                      onClick={async () => {
                        const epoch = identityEpoch.current;
                        const request = collectionRequest.current;
                        try {
                          await api(
                            'v1/account/collections/' + tab + '/' + item.id,
                            'DELETE',
                          );
                          if (
                            epoch !== identityEpoch.current ||
                            request !== collectionRequest.current
                          )
                            return;
                          setItems((previous) =>
                            previous.filter((v) => v.id !== item.id),
                          );
                          if (tab === 'favorite')
                            track({
                              type: 'favorite_removed',
                              listingId: item.id,
                            });
                        } catch (e) {
                          if (
                            epoch !== identityEpoch.current ||
                            request !== collectionRequest.current
                          )
                            return;
                          setNotice((e as Error).message);
                        }
                      }}
                    >
                      Удалить
                    </Button>
                  }
                />
              ))}
            </div>
          )}
          {tab === 'compare' && items.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <caption>Сравнение объектов</caption>
                <thead>
                  <tr>
                    <th scope="col">Параметр</th>
                    {items.map((i) => (
                      <th scope="col" key={i.id}>
                        {i.title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {['area', 'rooms', 'floor', 'floors'].map((key) => (
                    <tr key={key}>
                      <th scope="row">{attributeLabels[key] ?? key}</th>
                      {items.map((i) => (
                        <td key={i.id}>{String(i.attributes[key] ?? '—')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {tab === 'saved' && (
        <>
          {saved.length === 0 && (
            <p>Сохраните поиск на странице недвижимости.</p>
          )}
          {saved.map((s) => (
            <article className="panel" key={s.id}>
              <h2>{s.name}</h2>
              <Link
                href={
                  '/search?definition=' +
                  encodeURIComponent(JSON.stringify(s.definition))
                }
              >
                Открыть поиск
              </Link>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const epoch = identityEpoch.current;
                  const request = collectionRequest.current;
                  try {
                    await api('v1/account/saved-searches/' + s.id, 'PATCH', {
                      name: new FormData(e.currentTarget).get('name'),
                      definition: s.definition,
                    });
                    if (
                      epoch !== identityEpoch.current ||
                      request !== collectionRequest.current
                    )
                      return;
                    await load('saved');
                  } catch (error) {
                    if (
                      epoch !== identityEpoch.current ||
                      request !== collectionRequest.current
                    )
                      return;
                    setNotice((error as Error).message);
                  }
                }}
              >
                <label>
                  Название
                  <input
                    name="name"
                    defaultValue={s.name}
                    maxLength={100}
                    required
                  />
                </label>
                <Button type="submit">Переименовать</Button>
              </form>
              <Button
                onClick={async () => {
                  const epoch = identityEpoch.current;
                  const request = collectionRequest.current;
                  try {
                    await api('v1/account/saved-searches/' + s.id, 'DELETE');
                    if (
                      epoch !== identityEpoch.current ||
                      request !== collectionRequest.current
                    )
                      return;
                    await load('saved');
                  } catch (e) {
                    if (
                      epoch !== identityEpoch.current ||
                      request !== collectionRequest.current
                    )
                      return;
                    setNotice((e as Error).message);
                  }
                }}
              >
                Удалить поиск
              </Button>
            </article>
          ))}
        </>
      )}
      {tab === 'messages' && (
        <>
          {threads.length === 0 && (
            <p>Напишите продавцу на странице объявления.</p>
          )}
          {threads.map((t) => (
            <div className="panel" key={t.id}>
              <Link href={'/listings/' + t.listing_id}>Объявление</Link>{' '}
              <Button onClick={() => openThread(t.id)}>
                Открыть переписку
              </Button>
            </div>
          ))}
          {activeThread && (
            <section
              key={activeThread}
              className="panel"
              aria-label="Переписка"
            >
              {[...messages].reverse().map((m) => (
                <p key={m.id}>
                  {m.body}{' '}
                  <time dateTime={m.created_at}>
                    {new Date(m.created_at).toLocaleString('ru-RU')}
                  </time>
                </p>
              ))}
              {messageCursor && (
                <Button onClick={() => openThread(activeThread, messageCursor)}>
                  Предыдущие сообщения
                </Button>
              )}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const epoch = identityEpoch.current;
                  const form = e.currentTarget;
                  const navigation = navigationEpoch.current;
                  const request = threadRequest.current;
                  const submittedThread = activeThread;
                  try {
                    await api(
                      'v1/account/threads/' + submittedThread + '/messages',
                      'POST',
                      { body: new FormData(form).get('body') },
                    );
                    if (
                      epoch !== identityEpoch.current ||
                      navigation !== navigationEpoch.current ||
                      request !== threadRequest.current
                    )
                      return;
                    if (await openThread(submittedThread)) form.reset();
                  } catch (error) {
                    if (
                      epoch !== identityEpoch.current ||
                      navigation !== navigationEpoch.current ||
                      request !== threadRequest.current
                    )
                      return;
                    setNotice((error as Error).message);
                  }
                }}
              >
                <label>
                  Ответ
                  <textarea name="body" required maxLength={4000} />
                </label>
                <Button type="submit">Отправить</Button>
              </form>
            </section>
          )}
        </>
      )}
      {tab === 'notifications' && (
        <>
          <label>
            <input
              type="checkbox"
              checked={notificationEnabled}
              onChange={async (e) => {
                const epoch = identityEpoch.current;
                const value = e.target.checked;
                try {
                  const prefs = await api<{
                    in_app: boolean;
                    email: boolean;
                    sms: boolean;
                    push: boolean;
                  }>('v1/account/preferences');
                  if (epoch !== identityEpoch.current) return;
                  await api('v1/account/preferences', 'PATCH', {
                    ...prefs,
                    in_app: value,
                  });
                  if (epoch !== identityEpoch.current) return;
                  setNotificationEnabled(value);
                } catch (error) {
                  if (epoch !== identityEpoch.current) return;
                  setNotice((error as Error).message);
                }
              }}
            />{' '}
            Получать уведомления в аккаунте
          </label>
          {notifications.length === 0 && <p>Новых уведомлений нет.</p>}
          {notifications.map((n) => (
            <article className="panel" key={n.id}>
              <p>
                Новое сообщение · {n.read_at ? 'прочитано' : 'не прочитано'}
              </p>
              <Button
                onClick={async () => {
                  const epoch = identityEpoch.current;
                  const navigation = navigationEpoch.current;
                  let selectedNavigation = navigation;
                  let selectedThread = threadRequest.current;
                  try {
                    await api(
                      'v1/account/notifications/' + n.id + '/read',
                      'POST',
                    );
                    if (
                      epoch !== identityEpoch.current ||
                      selectedNavigation !== navigationEpoch.current ||
                      selectedThread !== threadRequest.current
                    )
                      return;
                    selectedNavigation = selectTab('messages');
                    selectedThread = threadRequest.current;
                    await load('messages');
                    if (
                      epoch !== identityEpoch.current ||
                      selectedNavigation !== navigationEpoch.current ||
                      selectedThread !== threadRequest.current
                    )
                      return;
                    await openThread(n.thread_id);
                  } catch (e) {
                    if (
                      epoch !== identityEpoch.current ||
                      selectedNavigation !== navigationEpoch.current ||
                      selectedThread !== threadRequest.current
                    )
                      return;
                    setNotice((e as Error).message);
                  }
                }}
              >
                Прочитать
              </Button>
            </article>
          ))}
        </>
      )}
      {cursor && (
        <Button onClick={() => load(tab, cursor)}>Показать ещё</Button>
      )}
    </>
  );
}
