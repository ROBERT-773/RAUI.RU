'use client';
import { Button } from '@raui/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/client';
import { invalidPhoneInput, normalizePhoneInput } from '../lib/phone-input';
import { CodeDialog } from './sign-in-code-dialog';

interface Challenge {
  challengeId: string;
  resendAfter: string;
  expiresAt: string;
  delivery?: 'accepted' | 'unknown' | 'unavailable';
}
type Verification<T> =
  | { kind: 'session'; user: T; csrfToken: string }
  | { kind: 'signup'; signupToken: string };
interface Session<T> {
  user: T;
  csrfToken: string;
  verificationDelivery?: 'accepted' | 'unavailable';
}

function browserKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type PhoneSignInProps<T> = { onOther: () => void; recoveryMode?: boolean } & (
  | { enrollmentPhone: string; onEnrolled: () => void; onSession?: never }
  | {
      enrollmentPhone?: never;
      onEnrolled?: never;
      onSession: (session: Session<T>) => void;
    }
);

type Operation = 'request' | 'resend' | 'confirm' | 'register' | 'enroll';
export type SessionSignInProps<T> = Extract<
  PhoneSignInProps<T>,
  { onSession: unknown }
>;

export default function PhoneSignIn<T>(props: PhoneSignInProps<T>) {
  return <SignInByCode {...props} channel="phone" />;
}

export function SignInByCode<T>(
  props:
    | (PhoneSignInProps<T> & { channel: 'phone' })
    | (SessionSignInProps<T> & { channel: 'email' }),
) {
  const email = props.channel === 'email';
  const path = email ? 'v1/auth/email-sign-in' : 'v1/auth/phone-sign-in';
  const [destination, setDestination] = useState(
    email ? '' : (props.enrollmentPhone ?? '+7'),
  );
  const normalized = email
    ? destination.trim().toLowerCase()
    : normalizePhoneInput(destination);
  const [retryWindows, setRetryWindows] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const retryUntil = normalized ? retryWindows.get(normalized) : undefined;
  const [registrationRole, setRegistrationRole] = useState('buyer');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [signupToken, setSignupToken] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [failedAction, setFailedAction] = useState<Operation | null>(null);
  const [uncertainResend, setUncertainResend] = useState(false);
  const lock = useRef<Operation | null>(null);
  const epoch = useRef(0);
  const destinationField = useRef<HTMLInputElement>(null);
  const signupRole = useRef<HTMLSelectElement>(null);
  const focusPhone = useRef(false);
  const busy = operation !== null;
  const committed =
    operation === 'confirm' ||
    operation === 'enroll' ||
    operation === 'register';
  const browser = useRef('');
  const lastSend = useRef<{
    destination: string;
    replaces: string | null;
    key: string;
  } | null>(null);

  useEffect(() => {
    if (!normalized || !retryUntil) return;
    const expire = () => {
      if (Date.now() < retryUntil) return;
      setRetryWindows((previous) => {
        if (previous.get(normalized) !== retryUntil) return previous;
        const next = new Map(previous);
        next.delete(normalized);
        return next;
      });
    };
    const timer = window.setTimeout(
      expire,
      Math.max(0, retryUntil - Date.now()),
    );
    window.addEventListener('focus', expire);
    document.addEventListener('visibilitychange', expire);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', expire);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [normalized, retryUntil]);

  useEffect(() => {
    const generation = epoch;
    return () => {
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (signupToken) signupRole.current?.focus();
    else if (focusPhone.current && !challenge) {
      focusPhone.current = false;
      destinationField.current?.focus();
    }
  }, [signupToken, challenge]);
  function resetChallenge(returnFocus = false) {
    if (lock.current && lock.current !== 'request' && lock.current !== 'resend')
      return;
    epoch.current++;
    lock.current = null;
    setOperation(null);
    focusPhone.current = returnFocus;
    setChallenge(null);
    setSignupToken('');
    setNotice('');
    setError('');
    setFailedAction(null);
    setUncertainResend(false);
    if (props.enrollmentPhone || signupToken) lastSend.current = null;
  }

  async function execute(action: Operation, form?: FormData, code?: string) {
    if (lock.current) return;
    if (!normalized) {
      setError(email ? 'Введите адрес электронной почты.' : invalidPhoneInput);
      return;
    }
    if (action === 'request' && retryUntil && Date.now() < retryUntil) return;
    if (
      action === 'resend' &&
      (!challenge ||
        !Number.isFinite(Date.parse(challenge.resendAfter)) ||
        Date.parse(challenge.resendAfter) > Date.now())
    )
      return;
    const request = ++epoch.current;
    lock.current = action;
    setOperation(action);
    setError('');
    setFailedAction(null);
    try {
      browser.current ||= browserKey();
      const proof = email
        ? { email: normalized, browserKey: browser.current }
        : { phone: normalized, browserKey: browser.current };
      if (action === 'enroll' && challenge && props.onEnrolled && form) {
        await api(path + '/enroll', 'POST', {
          ...proof,
          challengeId: challenge.challengeId,
          code: form.get('code'),
          password: form.get('password'),
        });
        if (request === epoch.current) props.onEnrolled();
      } else if (
        action === 'register' &&
        signupToken &&
        props.onSession &&
        form
      ) {
        const session = await api<Session<T>>(path + '/register', 'POST', {
          ...proof,
          signupToken,
          email: form.get('email'),
          password: form.get('password'),
          displayName: form.get('name'),
          role: form.get('role'),
        });
        if (request === epoch.current) props.onSession(session);
      } else if (action === 'confirm' && challenge && props.onSession && code) {
        const confirmation = {
          ...proof,
          challengeId: challenge.challengeId,
          code,
        };
        if (email) {
          const session = await api<Session<T>>(path + '/confirm', 'POST', {
            ...confirmation,
            ...(props.recoveryMode
              ? { existingOnly: true }
              : registrationRole === 'buyer'
                ? {}
                : { registrationRole }),
          });
          if (request !== epoch.current) return;
          setChallenge(null);
          props.onSession(session);
          return;
        }
        const result = await api<Verification<T>>(
          path + '/confirm',
          'POST',
          confirmation,
        );
        if (request !== epoch.current) return;
        setChallenge(null);
        if (result.kind === 'session') props.onSession(result);
        else if (props.recoveryMode) {
          focusPhone.current = true;
          lastSend.current = null;
          setError(
            'Восстановить доступ не удалось. Проверьте номер или выберите другой способ входа.',
          );
        } else {
          setSignupToken(result.signupToken);
          setNotice('Телефон подтверждён. Заполните профиль.');
        }
      } else if (action === 'request' || action === 'resend') {
        // Replaying a lost HTTP response must reuse the same key. Only an
        // explicit resend for an acknowledged challenge starts another send.
        if (
          !lastSend.current ||
          lastSend.current.destination !== normalized ||
          (action === 'resend' &&
            lastSend.current.replaces !== challenge!.challengeId)
        ) {
          lastSend.current = {
            destination: normalized,
            replaces: action === 'resend' ? challenge!.challengeId : null,
            key: crypto.randomUUID(),
          };
        }
        setDestination(normalized);
        const result = await api<Challenge>(path, 'POST', proof, {
          idempotencyKey: lastSend.current.key,
        });
        if (request !== epoch.current) return;
        setUncertainResend(false);
        if (result.delivery === 'unavailable') {
          lastSend.current = null;
          if (action === 'resend' && challenge)
            setChallenge({ ...challenge, resendAfter: result.resendAfter });
          setError('Сейчас не удалось отправить код. Попробуйте позже.');
        } else {
          setChallenge(result);
          if (props.onEnrolled)
            setNotice(
              result.delivery === 'unknown'
                ? 'Отправку не удалось подтвердить. Если SMS придёт, введите код.'
                : 'Если SMS пришло, введите код из сообщения.',
            );
        }
      }
    } catch (failure) {
      if (request !== epoch.current) return;
      setFailedAction(action);
      if (action === 'resend') {
        const uncertain =
          !(failure instanceof ApiError) ||
          (failure.status >= 500 && failure.status !== 503);
        setUncertainResend(uncertain);
        if (
          failure instanceof ApiError &&
          failure.retryAfterSeconds &&
          challenge
        ) {
          setChallenge({
            ...challenge,
            resendAfter: new Date(
              Date.now() + failure.retryAfterSeconds * 1000,
            ).toISOString(),
          });
        }
      }
      if (failure instanceof ApiError && failure.status === 401)
        setError(
          props.enrollmentPhone
            ? 'Пароль или код неверный либо срок действия кода истёк.'
            : signupToken
              ? 'Срок регистрации истёк. Запросите новый код.'
              : 'Код неверный или истёк.',
        );
      else if (failure instanceof ApiError && failure.status === 429) {
        if (action === 'request' && failure.retryAfterSeconds) {
          const now = Date.now(),
            until = now + failure.retryAfterSeconds * 1000;
          setRetryWindows((previous) => {
            const next = new Map(
              [...previous].filter(([, deadline]) => deadline > now),
            );
            next.set(normalized, until);
            return next;
          });
        } else setError('Слишком много запросов. Попробуйте позже.');
      } else if (
        failure instanceof ApiError &&
        failure.status === 503 &&
        (action === 'request' || action === 'resend')
      ) {
        lastSend.current = null;
        setError('Сейчас не удалось отправить код. Попробуйте позже.');
      } else if (failure instanceof TypeError)
        setError(
          'Не удалось связаться с порталом. Проверьте подключение и попробуйте ещё раз.',
        );
      else
        setError(
          failure instanceof Error ? failure.message : 'Попробуйте ещё раз.',
        );
    } finally {
      if (request === epoch.current) {
        lock.current = null;
        setOperation(null);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (signupToken) void execute('register', form);
    else if (challenge && props.onEnrolled) void execute('enroll', form);
    else if (!challenge) void execute('request');
  }
  const codeDialog = Boolean(challenge && props.onSession);

  return (
    <>
      {props.enrollmentPhone ? (
        <h4>Подключить вход по SMS</h4>
      ) : (
        <h1>
          {props.recoveryMode ? 'Восстановить доступ' : 'Вход или регистрация'}
        </h1>
      )}
      <form className="account-form panel" onSubmit={submit}>
        <label>
          {email ? 'Email' : 'Мобильный телефон'}
          <input
            ref={destinationField}
            type={email ? 'email' : 'tel'}
            autoComplete={email ? 'email' : 'tel'}
            value={destination}
            disabled={
              committed ||
              Boolean(challenge) ||
              Boolean(signupToken) ||
              Boolean(props.enrollmentPhone)
            }
            required
            onChange={(event) => {
              resetChallenge();
              setDestination(event.target.value);
            }}
          />
        </label>
        {email && !props.recoveryMode && !challenge && (
          <details>
            <summary>Роль при регистрации</summary>
            <label>
              Кто вы?
              <select
                value={registrationRole}
                onChange={(event) => setRegistrationRole(event.target.value)}
              >
                <option value="buyer">Ищу недвижимость</option>
                <option value="owner">Собственник</option>
                <option value="agent">Агент</option>
                <option value="agency">Агентство</option>
                <option value="developer">Застройщик</option>
              </select>
            </label>
            <p>Выбранная роль используется при создании аккаунта.</p>
          </details>
        )}
        {challenge && props.onEnrolled && (
          <label>
            Код из SMS
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={busy}
            />
          </label>
        )}
        {challenge && props.enrollmentPhone && (
          <label>
            Текущий пароль
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
              disabled={busy}
            />
          </label>
        )}
        {signupToken && (
          <>
            <label>
              Кто вы?
              <select
                ref={signupRole}
                name="role"
                defaultValue=""
                required
                disabled={busy}
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
            <label>
              Имя
              <input
                name="name"
                autoComplete="name"
                maxLength={100}
                required
                disabled={busy}
              />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={busy}
              />
            </label>
            <label>
              Пароль
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
          </>
        )}
        {!codeDialog && (
          <Button
            type="submit"
            disabled={
              busy || (!signupToken && !challenge && Boolean(retryUntil))
            }
          >
            {signupToken
              ? 'Создать аккаунт'
              : challenge
                ? 'Подключить'
                : 'Получить код'}
          </Button>
        )}
        {(signupToken || (challenge && props.onEnrolled)) && (
          <Button disabled={busy} onClick={() => resetChallenge(true)}>
            Запросить новый код или изменить номер
          </Button>
        )}
        <Button
          disabled={committed}
          onClick={() => {
            if (
              lock.current &&
              lock.current !== 'request' &&
              lock.current !== 'resend'
            )
              return;
            resetChallenge();
            props.onOther();
          }}
        >
          {props.enrollmentPhone ? 'Отмена' : 'Другой способ'}
        </Button>
        {notice && <p role="status">{notice}</p>}
        {retryUntil && !challenge && !signupToken && (
          <p role="status">
            Слишком много запросов. Новый код можно запросить в{' '}
            <time dateTime={new Date(retryUntil).toISOString()}>
              {new Date(retryUntil).toLocaleTimeString('ru-RU')}
            </time>
            .
          </p>
        )}
        {!codeDialog && error && <p role="alert">{error}</p>}
      </form>
      {codeDialog && challenge && (
        <CodeDialog
          key={challenge.challengeId}
          channel={props.channel}
          destination={destination}
          delivery={challenge.delivery ?? 'accepted'}
          resendAfter={challenge.resendAfter}
          expiresAt={challenge.expiresAt}
          verifying={operation === 'confirm'}
          sending={operation === 'resend'}
          uncertainResend={uncertainResend}
          error={error}
          verificationFailed={failedAction === 'confirm'}
          onConfirm={(code) => void execute('confirm', undefined, code)}
          onResend={() => void execute('resend')}
          onClose={() => resetChallenge(true)}
        />
      )}
    </>
  );
}
