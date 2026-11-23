'use client';
import { Button } from '@raui/ui';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/client';
import { invalidPhoneInput, normalizePhoneInput } from '../lib/phone-input';

interface Challenge {
  challengeId: string;
  delivery: 'accepted' | 'unknown' | 'unavailable';
}
type Verification<T> =
  | { kind: 'session'; user: T; csrfToken: string }
  | { kind: 'signup'; signupToken: string };
interface Session<T> {
  user: T;
  csrfToken: string;
  verificationDelivery?: 'accepted' | 'unavailable';
}
const path = 'v1/auth/phone-sign-in';

function browserKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type PhoneSignInProps<T> = { onOther: () => void } & (
  | { enrollmentPhone: string; onEnrolled: () => void; onSession?: never }
  | {
      enrollmentPhone?: never;
      onEnrolled?: never;
      onSession: (session: Session<T>) => void;
    }
);

export default function PhoneSignIn<T>(props: PhoneSignInProps<T>) {
  const [phone, setPhone] = useState(props.enrollmentPhone ?? '+7');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [signupToken, setSignupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const browser = useRef('');
  const requestKey = useRef('');

  function resetChallenge() {
    setChallenge(null);
    setSignupToken('');
    setNotice('');
    setError('');
    requestKey.current = '';
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    const normalized = normalizePhoneInput(phone);
    if (!normalized) {
      setError(invalidPhoneInput);
      return;
    }
    const form = new FormData(event.currentTarget);
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      browser.current ||= browserKey();
      const proof = { phone: normalized, browserKey: browser.current };
      if (challenge && props.onEnrolled) {
        await api(path + '/enroll', 'POST', {
          ...proof,
          challengeId: challenge.challengeId,
          code: form.get('code'),
          password: form.get('password'),
        });
        props.onEnrolled();
      } else if (signupToken && props.onSession) {
        const session = await api<Session<T>>(path + '/register', 'POST', {
          ...proof,
          signupToken,
          email: form.get('email'),
          password: form.get('password'),
          displayName: form.get('name'),
          role: form.get('role'),
        });
        props.onSession(session);
      } else if (challenge && props.onSession) {
        const result = await api<Verification<T>>(path + '/confirm', 'POST', {
          ...proof,
          challengeId: challenge.challengeId,
          code: form.get('code'),
        });
        if (result.kind === 'session') props.onSession(result);
        else {
          setSignupToken(result.signupToken);
          setNotice('Телефон подтверждён. Заполните профиль.');
        }
      } else {
        requestKey.current ||= crypto.randomUUID();
        setPhone(normalized);
        const result = await api<Challenge>(path, 'POST', proof, {
          idempotencyKey: requestKey.current,
        });
        if (result.delivery === 'unavailable') {
          requestKey.current = '';
          setError(
            'SMS сейчас недоступно. Попробуйте позже или войдите по почте.',
          );
        } else {
          setChallenge(result);
          setNotice(
            result.delivery === 'unknown'
              ? 'Отправку не удалось подтвердить. Если SMS придёт, введите код.'
              : 'Если SMS пришло, введите код из сообщения.',
          );
        }
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401)
        setError(
          props.enrollmentPhone
            ? 'Пароль или код неверный либо срок действия кода истёк.'
            : signupToken
              ? 'Срок регистрации истёк. Запросите новый код.'
              : 'Код неверный или истёк.',
        );
      else if (failure instanceof ApiError && failure.status === 429)
        setError('Слишком много запросов. Попробуйте позже.');
      else
        setError(
          failure instanceof Error ? failure.message : 'Попробуйте ещё раз.',
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {props.enrollmentPhone ? (
        <h4>Подключить вход по SMS</h4>
      ) : (
        <h1>Вход или регистрация</h1>
      )}
      <form className="account-form panel" onSubmit={submit}>
        <label>
          Мобильный телефон
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            disabled={
              busy || Boolean(challenge) || Boolean(props.enrollmentPhone)
            }
            required
            onChange={(event) => {
              resetChallenge();
              setPhone(event.target.value);
            }}
          />
        </label>
        {challenge && !signupToken && (
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
              <select name="role" defaultValue="" required disabled={busy}>
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
        <Button type="submit" disabled={busy}>
          {signupToken
            ? 'Создать аккаунт'
            : challenge
              ? props.enrollmentPhone
                ? 'Подключить'
                : 'Подтвердить код'
              : 'Получить код'}
        </Button>
        {challenge && (
          <Button disabled={busy} onClick={resetChallenge}>
            Запросить новый код или изменить номер
          </Button>
        )}
        <Button disabled={busy} onClick={props.onOther}>
          {props.enrollmentPhone ? 'Отмена' : 'Другой способ'}
        </Button>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </form>
    </>
  );
}
