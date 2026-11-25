'use client';
import { Button } from '@raui/ui';
import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError, setCsrf } from '../lib/client';
import { SignInByCode } from './phone-sign-in';

export type PasswordChangeMode = 'recent-code' | 'current-password';

export default function AccountPassword({
  mode,
  email,
  phone,
  userId,
  onSessionExpired,
}: {
  mode: PasswordChangeMode;
  email: string | undefined;
  phone: string | undefined;
  userId: string;
  onSessionExpired: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [needsCurrent, setNeedsCurrent] = useState(mode === 'current-password');
  const [channel, setChannel] = useState<'email' | 'phone' | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== form.get('confirmation')) {
      setError('Пароли не совпадают.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const session = await api<{ csrfToken: string }>(
        'v1/auth/password',
        'POST',
        {
          password,
          ...(needsCurrent
            ? { currentPassword: String(form.get('currentPassword') ?? '') }
            : {}),
        },
      );
      setEditing(false);
      setNeedsCurrent(true);
      setNotice('Пароль сохранён.');
      try {
        setCsrf(session.csrfToken);
      } catch {
        /* The session cookie has already rotated. */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onSessionExpired();
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        setNeedsCurrent(true);
        setError(
          needsCurrent
            ? 'Проверьте текущий пароль.'
            : 'Подтвердите смену пароля ещё раз.',
        );
      } else
        setError(
          e instanceof ApiError && e.status === 429
            ? 'Слишком много попыток. Попробуйте позже.'
            : 'Не удалось сохранить пароль. Попробуйте ещё раз.',
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <h3>Пароль</h3>
      {channel ? (
        <SignInByCode<{ id: string }>
          channel={channel}
          fixedDestination={channel === 'email' ? email : phone}
          recoveryMode
          onOther={() => setChannel(null)}
          onSession={(session) => {
            if (session.user.id !== userId) {
              window.location.replace('/account');
              return;
            }
            try {
              setCsrf(session.csrfToken);
            } catch {
              /* The next request can recover CSRF. */
            }
            setNeedsCurrent(false);
            setError('');
            setChannel(null);
          }}
        />
      ) : editing ? (
        <form className="account-form" onSubmit={save}>
          {needsCurrent && (
            <label>
              Текущий пароль
              <input
                type="password"
                autoComplete="current-password"
                name="currentPassword"
                maxLength={128}
                disabled={busy}
                required
              />
            </label>
          )}
          <label>
            Новый пароль
            <input
              type="password"
              autoComplete="new-password"
              name="password"
              minLength={12}
              maxLength={128}
              disabled={busy}
              required
            />
          </label>
          <label>
            Повторите новый пароль
            <input
              type="password"
              autoComplete="new-password"
              name="confirmation"
              minLength={12}
              maxLength={128}
              disabled={busy}
              required
            />
          </label>
          <p>
            От 12 до 128 символов. На других устройствах потребуется войти
            снова.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="actions">
            <Button type="submit" className="primary" disabled={busy}>
              Сохранить пароль
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Отмена
            </Button>
          </div>
          {needsCurrent && (email || phone) && (
            <div>
              <p>Забыли текущий пароль?</p>
              <div className="actions">
                {email && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => setChannel('email')}
                  >
                    Получить код на почту
                  </Button>
                )}
                {phone && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => setChannel('phone')}
                  >
                    Получить код по SMS
                  </Button>
                )}
              </div>
            </div>
          )}
        </form>
      ) : (
        <Button
          onClick={() => {
            setEditing(true);
            setNotice('');
            setError('');
          }}
        >
          Установить или сменить пароль
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
