'use client';
import { Button } from '@raui/ui';
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import type {
  AccountNotification,
  ListingCard,
  SearchDefinition,
} from '@raui/types/product';
import { api, setCsrf, track } from '../lib/client';
import { attributeLabels } from '../lib/labels';
import { savedSearchSummary } from '../lib/saved-search-summary';
import { Card } from './card';
import AgencyPublicProfiles from './agency-public-profiles';
import ProfessionalFeedLinks from './professional-feed-links';
import AgentPublicProfile from './agent-public-profile';
import AccountProfile from './account-profile';
import AccountSubscriptions from './account-subscriptions';
import PhoneSignIn from './phone-sign-in';
import EmailCodeSignIn from './email-code-sign-in';
import ListingSummary from './listing-summary';
import {
  announceFeedbackIdentityChange,
  clearFeedbackDraft,
  resumeFeedbackAfterLogin,
} from '../lib/feedback-draft';
export interface AccountUser {
  id: string;
  role: string;
  display_name: string;
  public_id: string;
  email_verified_at?: string | null;
  phone_verified_at?: string | null;
  registration_approval_state?: 'pending' | 'approved' | 'rejected';
  registration_approval_reason?: string | null;
}
const cabinetTitles = new Map([
  ['buyer', 'Кабинет покупателя'],
  ['owner', 'Кабинет собственника'],
  ['agent', 'Кабинет риелтора'],
  ['agency', 'Кабинет агентства'],
  ['developer', 'Кабинет застройщика'],
]);
const inboxPrice = (minor: number) => {
  const value = BigInt(minor);
  return `${(value / 100n).toLocaleString('ru-RU')},${(value % 100n).toString().padStart(2, '0')} ₽`;
};
const sessionExpired = (error: unknown) =>
  error instanceof Error && 'status' in error && error.status === 401;
function focusPasswordNotice(element: HTMLParagraphElement | null) {
  element?.focus();
}
const approved = (user: AccountUser) =>
  !user.registration_approval_state ||
  user.registration_approval_state === 'approved';
type Tab =
  | 'favorite'
  | 'compare'
  | 'recent'
  | 'saved'
  | 'messages'
  | 'notifications'
  | 'subscriptions';
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
export default function Account({
  continueListing = false,
  continueFeedback = false,
  initialTab = 'favorite',
  initialContacts = false,
  smsAvailable = false,
  emailAvailable = false,
  resetLinkAvailable = false,
  recoverAccess = false,
  compactEntry = false,
  entryTitle,
  onAuthenticated,
  renderEntry,
}: {
  continueListing?: boolean;
  continueFeedback?: boolean;
  initialTab?: 'favorite' | 'messages' | 'notifications';
  initialContacts?: boolean;
  smsAvailable?: boolean;
  emailAvailable?: boolean;
  resetLinkAvailable?: boolean;
  recoverAccess?: boolean;
  compactEntry?: boolean;
  entryTitle?: string;
  onAuthenticated?: (user: AccountUser) => void;
  renderEntry?: (content: ReactNode) => ReactNode;
} = {}) {
  const identifierEntry = compactEntry && !recoverAccess;
  const externalAccount = Boolean(onAuthenticated);
  const notifyAuthenticated = useEffectEvent((sessionUser: AccountUser) =>
    onAuthenticated?.(sessionUser),
  );
  const [user, setUser] = useState<AccountUser | null>(null),
    [profileOpen, setProfileOpen] = useState(initialContacts),
    [checking, setChecking] = useState(true),
    [tab, setTab] = useState<Tab>(initialTab),
    [notice, setNotice] = useState(''),
    [register, setRegister] = useState(false),
    [loginById, setLoginById] = useState(false),
    [identifier, setIdentifier] = useState(''),
    [signInMethod, setSignInMethod] = useState<
      'phone' | 'email' | 'password' | 'recovery'
    >(
      recoverAccess && smsAvailable && emailAvailable
        ? 'recovery'
        : smsAvailable
          ? 'phone'
          : identifierEntry || emailAvailable
            ? 'email'
            : 'password',
    ),
    [passwordVisible, setPasswordVisible] = useState(false),
    [passwordSubmitting, setPasswordSubmitting] = useState(false),
    [items, setItems] = useState<ListingCard[]>([]),
    [saved, setSaved] = useState<Saved[]>([]),
    [threads, setThreads] = useState<Thread[]>([]),
    [notifications, setNotifications] = useState<AccountNotification[]>([]),
    [activeThread, setActiveThread] = useState(''),
    [messages, setMessages] = useState<Message[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [messageCursor, setMessageCursor] = useState<string | null>(null),
    [notificationEnabled, setNotificationEnabled] = useState(true);
  const focusAfterCode = useRef(compactEntry && !externalAccount);
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
  const feedbackUser = continueFeedback ? user?.id : undefined;
  useEffect(() => {
    if (externalAccount && user) notifyAuthenticated(user);
  }, [externalAccount, user]);
  useEffect(() => {
    if (feedbackUser) resumeFeedbackAfterLogin(feedbackUser);
  }, [feedbackUser]);
  function clearPrivateState() {
    const epoch = ++identityEpoch.current;
    setTab(initialTab);
    setProfileOpen(initialContacts);
    setNotice('');
    setRegister(false);
    setLoginById(false);
    setIdentifier('');
    if (identifierEntry) setSignInMethod(smsAvailable ? 'phone' : 'email');
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
        if (approved(u) && !externalAccount) void load(initialTab);
      })
      .catch(() => {})
      .finally(() => {
        if (epoch === identityEpoch.current) setChecking(false);
      });
    return () => {
      epochRef.current++;
    };
  }, [initialTab, externalAccount]);
  async function load(t: Tab, after?: string) {
    if (t === 'subscriptions') return;
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
        const r = await api<{
          items: AccountNotification[];
          cursor: string | null;
        }>('v1/account/notifications' + (after ? '?cursor=' + after : ''));
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
    clearFeedbackDraft();
    announceFeedbackIdentityChange();
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
  function guestEntry(content: ReactNode) {
    const entry = compactEntry ? (
      <section className="raui-auth-surface">{content}</section>
    ) : (
      content
    );
    return renderEntry ? renderEntry(entry) : entry;
  }
  const recoveryHref =
    smsAvailable || emailAvailable
      ? '/account?action=recover'
      : '/account/forgot-password';
  function openPassword(value: string, registering = false) {
    setIdentifier(value);
    setRegister(registering);
    setLoginById(!registering && !value.includes('@'));
    setPasswordVisible(false);
    setNotice('');
    setSignInMethod('password');
  }
  function changeSignInMethod() {
    if (recoverAccess) setSignInMethod('recovery');
    else if (identifierEntry)
      setSignInMethod(signInMethod === 'phone' ? 'email' : 'phone');
    else setSignInMethod('password');
  }
  if (checking) return <p role="status">Проверяем аккаунт…</p>;
  if (user && externalAccount) return <p role="status">Открываем кабинет…</p>;
  if (feedbackUser) return <p role="status">Возвращаемся к предложению…</p>;
  if (!user && signInMethod === 'recovery')
    return guestEntry(
      <section className={compactEntry ? undefined : 'panel'}>
        <h1>Восстановить доступ</h1>
        <p>Куда отправить код для входа в ваш кабинет?</p>
        <div className="actions">
          {emailAvailable && (
            <Button
              className={compactEntry ? 'primary' : undefined}
              onClick={() => setSignInMethod('email')}
            >
              На почту
            </Button>
          )}
          {smsAvailable && (
            <Button
              className={
                compactEntry
                  ? emailAvailable
                    ? 'auth-secondary'
                    : 'primary'
                  : undefined
              }
              onClick={() => setSignInMethod('phone')}
            >
              На телефон
            </Button>
          )}
          {resetLinkAvailable && (
            <Link href="/account/forgot-password?mode=password">
              Сменить пароль по ссылке
            </Link>
          )}
          <Link href="/account">Вернуться ко входу</Link>
        </div>
      </section>,
    );
  if (!user && (signInMethod === 'phone' || signInMethod === 'email')) {
    const CodeSignIn =
      signInMethod === 'phone'
        ? PhoneSignIn<AccountUser>
        : EmailCodeSignIn<AccountUser>;
    return guestEntry(
      <CodeSignIn
        compactEntry={compactEntry}
        entryTitle={entryTitle}
        {...(identifierEntry &&
          signInMethod === 'email' && {
            identifierOptions: {
              initialValue: identifier,
              emailAvailable,
              smsAvailable,
              recoveryHref,
              onPassword: openPassword,
              onRegister: (value: string) => openPassword(value, true),
            },
          })}
        recoveryMode={recoverAccess}
        onOther={changeSignInMethod}
        onSession={({
          user: next,
          csrfToken,
          verificationDelivery,
        }: {
          user: AccountUser;
          csrfToken: string;
          verificationDelivery?: 'accepted' | 'unavailable';
        }) => {
          clearPrivateState();
          setCsrf(csrfToken);
          if (recoverAccess) setProfileOpen(true);
          focusAfterCode.current = !continueFeedback;
          setUser(next);
          announceFeedbackIdentityChange();
          if (verificationDelivery === 'unavailable')
            setNotice(
              'Аккаунт создан. Запросите подтверждение почты повторно в профиле.',
            );
          if (approved(next) && !externalAccount) void load(initialTab);
        }}
      />,
    );
  }
  if (!user)
    return guestEntry(
      <>
        <h1>
          {register
            ? 'Создать аккаунт'
            : identifierEntry
              ? 'Введите пароль'
              : 'Войти в аккаунт'}
        </h1>
        <form
          className={compactEntry ? 'account-form' : 'account-form panel'}
          aria-busy={passwordSubmitting}
          onChange={() => setNotice('')}
          onSubmit={async (e) => {
            e.preventDefault();
            if (passwordSubmitting) return;
            setPasswordVisible(false);
            const epoch = identityEpoch.current;
            const d = new FormData(e.currentTarget);
            setPasswordSubmitting(true);
            setNotice('');
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
                ...(loginById && !register
                  ? { publicId: d.get('publicId') }
                  : { email: d.get('email') }),
                password: d.get('password'),
                transport: 'cookie',
              });
              if (epoch !== identityEpoch.current) return;
              clearPrivateState();
              setCsrf(result.csrfToken);
              setUser(result.user);
              announceFeedbackIdentityChange();
              if (deliveryUnavailable)
                setNotice(
                  'Аккаунт создан. Не удалось подтвердить отправку письма. Запросите письмо повторно в профиле.',
                );
              if (approved(result.user) && !externalAccount)
                void load(initialTab);
            } catch (error) {
              if (epoch !== identityEpoch.current) return;
              setNotice(
                !register && sessionExpired(error)
                  ? loginById
                    ? 'Не удалось войти. Проверьте ID пользователя и пароль.'
                    : 'Не удалось войти. Проверьте адрес почты и пароль.'
                  : (error as Error).message,
              );
            } finally {
              setPasswordSubmitting(false);
            }
          }}
        >
          {register && (
            <>
              <label>
                Кто вы?
                <select
                  name="role"
                  autoFocus
                  defaultValue=""
                  disabled={passwordSubmitting}
                  required
                  aria-describedby="registration-role-help"
                >
                  <option value="" disabled>
                    Выберите роль
                  </option>
                  <option value="buyer">Ищу недвижимость</option>
                  <option value="owner">Собственник</option>
                  <option value="agent">Агент</option>
                  <option value="agency">Агентство</option>
                  <option value="developer">Застройщик</option>
                </select>
              </label>
              <p id="registration-role-help">
                Покупаете или арендуете — «Ищу недвижимость». Размещаете свой
                объект — «Собственник». Работаете риелтором — «Агент».
                Представляете агентство — «Агентство», строительную компанию —
                «Застройщик».
              </p>
              <label>
                Имя
                <input
                  name="name"
                  autoComplete="name"
                  readOnly={passwordSubmitting}
                  required
                  maxLength={100}
                />
              </label>
            </>
          )}
          {identifierEntry && !register ? (
            <>
              <p className="auth-identifier">{identifier}</p>
              <input
                type="hidden"
                name={loginById ? 'publicId' : 'email'}
                autoComplete="username"
                value={identifier}
              />
            </>
          ) : loginById && !register ? (
            <label key="publicId">
              ID пользователя
              <input
                name="publicId"
                inputMode="numeric"
                autoComplete="username"
                pattern="[1-9][0-9]{0,18}"
                maxLength={19}
                readOnly={passwordSubmitting}
                required
              />
            </label>
          ) : (
            <label key="email">
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                defaultValue={
                  identifierEntry && identifier.includes('@')
                    ? identifier
                    : undefined
                }
                readOnly={passwordSubmitting}
                required
              />
            </label>
          )}
          {notice && (
            <p
              ref={focusPasswordNotice}
              tabIndex={-1}
              className="password-form-notice"
              id="password-form-notice"
              role="alert"
            >
              {notice}
            </p>
          )}
          <label>
            Пароль
            <input
              name="password"
              type={passwordVisible ? 'text' : 'password'}
              autoComplete={register ? 'new-password' : 'current-password'}
              autoFocus={identifierEntry && !register}
              minLength={register ? 12 : undefined}
              aria-describedby={notice ? 'password-form-notice' : undefined}
              readOnly={passwordSubmitting}
              required
            />
          </label>
          <Button
            className={compactEntry ? 'auth-secondary' : undefined}
            onClick={() => setPasswordVisible(!passwordVisible)}
          >
            {passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
          </Button>
          <Button
            className="primary"
            type="submit"
            disabled={passwordSubmitting}
          >
            {passwordSubmitting
              ? 'Проверяем данные…'
              : register
                ? 'Создать и войти'
                : 'Войти'}
          </Button>
        </form>
        {!register && (
          <p>
            <Link
              className={compactEntry ? 'auth-secondary' : undefined}
              href={recoveryHref}
            >
              Забыли пароль?
            </Link>
          </p>
        )}
        {identifierEntry ? (
          <Button
            className="auth-secondary"
            disabled={passwordSubmitting}
            onClick={() => {
              setRegister(false);
              setPasswordVisible(false);
              setNotice('');
              setSignInMethod('email');
            }}
          >
            Назад
          </Button>
        ) : (
          <>
            {!register && (
              <Button
                disabled={passwordSubmitting}
                onClick={() => {
                  setPasswordVisible(false);
                  setNotice('');
                  setLoginById(!loginById);
                }}
              >
                {loginById ? 'Войти по email' : 'Войти по ID'}
              </Button>
            )}
            <Button
              disabled={passwordSubmitting}
              onClick={() => {
                setPasswordVisible(false);
                setLoginById(false);
                setNotice('');
                setRegister(!register);
              }}
            >
              {register ? 'Уже есть аккаунт' : 'Регистрация'}
            </Button>
            {smsAvailable && (
              <Button
                disabled={passwordSubmitting}
                onClick={() => {
                  setNotice('');
                  setPasswordVisible(false);
                  setSignInMethod('phone');
                }}
              >
                Войти по SMS
              </Button>
            )}
            {emailAvailable && (
              <Button
                disabled={passwordSubmitting}
                onClick={() => {
                  setNotice('');
                  setPasswordVisible(false);
                  setSignInMethod('email');
                }}
              >
                Получить код на почту
              </Button>
            )}
          </>
        )}
      </>,
    );
  const logoutButton = (
    <Button
      onClick={async () => {
        const epoch = clearPrivateState();
        try {
          await api('v1/auth/logout', 'POST');
          if (epoch !== identityEpoch.current) return;
          clearFeedbackDraft();
          announceFeedbackIdentityChange();
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
  const heading = (
    <h1
      tabIndex={-1}
      ref={(element) => {
        if (element && focusAfterCode.current) {
          focusAfterCode.current = false;
          element.focus();
        }
      }}
    >
      {cabinetTitles.get(user.role) ?? 'Мой аккаунт'}
    </h1>
  );
  const canList = ['owner', 'agent', 'agency', 'developer', 'admin'].includes(
    user.role,
  );
  const canContinueListing = Boolean(
    user.email_verified_at && user.phone_verified_at,
  );
  if (!approved(user) || profileOpen)
    return (
      <>
        {heading}
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
          focusContacts={initialContacts}
          key={'account-profile-' + identityEpoch.current}
          smsAvailable={smsAvailable}
          emailAvailable={emailAvailable}
          resetLinkAvailable={resetLinkAvailable}
          onRefresh={refreshProfile}
          onSessionExpired={() => expireIdentity(profileEpoch)}
        />
      </>
    );
  return (
    <>
      {heading}
      <p>{user.display_name}</p>
      <p>ID: {user.public_id}</p>
      {continueListing &&
        canList &&
        (canContinueListing ? (
          <Link href="/account/listings#new-listing">
            Продолжить подачу объявления
          </Link>
        ) : (
          <Button onClick={() => setProfileOpen(true)}>
            Подтвердить контакты для подачи
          </Button>
        ))}
      {canList &&
        (canContinueListing ? (
          <ListingSummary key={'listings-' + user.id} />
        ) : (
          <Link href="/account/listings">Мои объявления</Link>
        ))}
      {user.role === 'admin' && (
        <nav className="actions" aria-label="Разделы администратора">
          <Link href="/admin/search">Поиск пользователей и объявлений</Link>
          <Link href="/admin/feeds">Автопубликация из XML</Link>
          <Link href="/admin/feedback">Предложения о портале</Link>
          <Link href="/admin/support">Обращения в поддержку</Link>
        </nav>
      )}
      {user.role === 'agent' && (
        <AgentPublicProfile key={'agent-profile-' + user.id} />
      )}
      {user.role === 'agent' && (
        <ProfessionalFeedLinks
          key={'feeds-' + user.id}
          onVerifyContacts={
            canContinueListing ? undefined : () => setProfileOpen(true)
          }
        />
      )}
      {['agent', 'agency', 'developer'].includes(user.role) && (
        <AgencyPublicProfiles
          key={'organizations-' + user.id}
          userId={user.id}
          canCreate={user.role === 'agency' || user.role === 'developer'}
          kind={user.role === 'developer' ? 'developer' : 'agency'}
          onVerifyContacts={
            canContinueListing ? undefined : () => setProfileOpen(true)
          }
        />
      )}
      {logoutButton}
      {(!continueListing || !canList || canContinueListing) && (
        <Button onClick={() => setProfileOpen(true)}>
          Профиль и подтверждение контактов
        </Button>
      )}
      <nav className="toolbar" aria-label="Разделы аккаунта">
        {(
          [
            ['favorite', 'Избранное'],
            ['compare', 'Сравнение'],
            ['recent', 'История'],
            ['saved', 'Сохранённые поиски'],
            ['messages', 'Сообщения'],
            ['notifications', 'Уведомления'],
            ['subscriptions', 'Подписки'],
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
              <p style={{ overflowWrap: 'anywhere' }}>
                {savedSearchSummary(s.definition)}
              </p>
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
      {tab === 'subscriptions' && (
        <AccountSubscriptions key={'subscriptions-' + user.id} />
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
          {notifications.length === 0 && !cursor && (
            <p>Новых уведомлений нет.</p>
          )}
          {notifications.map((n) => (
            <article className="panel" key={n.id}>
              {n.kind === 'message' ? (
                <>
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
                </>
              ) : (
                <>
                  <p>
                    {n.event.kind === 'price_drop'
                      ? `Цена снизилась до ${inboxPrice(n.event.priceMinor)}`
                      : n.event.available
                        ? 'Объявление снова доступно'
                        : 'Объявление больше недоступно'}
                  </p>
                  <p>{n.read_at ? 'прочитано' : 'не прочитано'}</p>
                  {(n.event.kind === 'price_drop' || n.event.available) && (
                    <Link href={'/listings/' + n.listing_id}>
                      Открыть объявление
                    </Link>
                  )}
                  <Button
                    disabled={Boolean(n.read_at)}
                    onClick={async () => {
                      const epoch = identityEpoch.current;
                      const navigation = navigationEpoch.current;
                      const request = collectionRequest.current;
                      try {
                        await api(
                          'v1/account/notifications/' + n.id + '/read',
                          'POST',
                        );
                        if (
                          epoch !== identityEpoch.current ||
                          navigation !== navigationEpoch.current ||
                          request !== collectionRequest.current
                        )
                          return;
                        setNotifications((previous) =>
                          previous.map((item) =>
                            item.id === n.id
                              ? { ...item, read_at: new Date().toISOString() }
                              : item,
                          ),
                        );
                      } catch (error) {
                        if (
                          epoch !== identityEpoch.current ||
                          navigation !== navigationEpoch.current ||
                          request !== collectionRequest.current
                        )
                          return;
                        setNotice((error as Error).message);
                      }
                    }}
                  >
                    Отметить прочитанным
                  </Button>
                </>
              )}
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
