'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@raui/ui';
import { api, setCsrf } from '../lib/client';

export default function PasswordRecovery({
  confirm = false,
}: {
  confirm?: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const capturedToken = useRef<string | null>(null);
  const [ready, setReady] = useState(!confirm);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!confirm) return;
    if (capturedToken.current === null) {
      capturedToken.current =
        new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
    setToken(
      /^[A-Za-z0-9_-]{43}$/.test(capturedToken.current)
        ? capturedToken.current
        : null,
    );
    setReady(true);
  }, [confirm]);

  return (
    <>
      <h1>{confirm ? 'Новый пароль' : 'Восстановить пароль'}</h1>
      {!ready ? (
        <p role="status">Проверяем ссылку…</p>
      ) : complete ? (
        <p role="status">
          {confirm
            ? 'Пароль изменён. Войдите с новым паролем.'
            : 'Если аккаунт с этим email существует, мы отправим ссылку для восстановления. Ссылка действует 15 минут.'}
        </p>
      ) : confirm && !token ? (
        <p role="alert">
          Ссылка недействительна. Запросите новую ссылку для восстановления.
        </p>
      ) : (
        <form
          className="account-form panel"
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting.current) return;
            const form = new FormData(event.currentTarget);
            setError('');
            const password = String(form.get('password') ?? '');
            if (confirm && password !== form.get('confirmation')) {
              setError('Пароли не совпадают.');
              return;
            }
            if (confirm && (password.length < 12 || password.length > 128)) {
              setError('Пароль должен содержать от 12 до 128 символов.');
              return;
            }
            submitting.current = true;
            setBusy(true);
            try {
              if (confirm) {
                await api('v1/auth/password-reset/confirm', 'POST', {
                  token,
                  password,
                });
                setCsrf('');
                setToken(null);
                capturedToken.current = '';
              } else {
                await api('v1/auth/password-reset', 'POST', {
                  email: String(form.get('email') ?? '').trim(),
                });
              }
              setComplete(true);
            } catch {
              setError(
                confirm
                  ? 'Не удалось изменить пароль. Ссылка могла истечь или уже использоваться. Запросите новую ссылку или попробуйте позже.'
                  : 'Не удалось отправить запрос. Попробуйте позже.',
              );
            } finally {
              submitting.current = false;
              setBusy(false);
            }
          }}
        >
          {confirm ? (
            <>
              <label>
                Новый пароль
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
              <label>
                Повторите пароль
                <input
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                />
              </label>
              <p>
                От 12 до 128 символов. После смены пароля потребуется войти
                снова на всех устройствах.
              </p>
            </>
          ) : (
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                disabled={busy}
              />
            </label>
          )}
          <Button className="primary" type="submit" disabled={busy}>
            {busy
              ? confirm
                ? 'Сохраняем…'
                : 'Отправляем…'
              : confirm
                ? 'Сохранить пароль'
                : 'Отправить ссылку'}
          </Button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      {confirm && !complete && (
        <p>
          <Link href="/account/forgot-password">Запросить новую ссылку</Link>
        </p>
      )}
      <p>
        <Link href="/account">Войти в аккаунт</Link>
      </p>
    </>
  );
}
