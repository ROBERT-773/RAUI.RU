'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/client';

interface StaffVerification {
  enrolled: boolean;
  assuredUntil: string | null;
  available: boolean;
  required: boolean;
}

const endpoint = 'v1/auth/staff-totp/';

export default function StaffTwoFactor({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StaffVerification>();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api<StaffVerification>(endpoint + 'status').then(
      (value) => {
        if (active)
          setState({
            ...value,
            assuredUntil:
              value.assuredUntil && Date.parse(value.assuredUntil) > Date.now()
                ? value.assuredUntil
                : null,
          });
      },
      (failure: unknown) => {
        if (!active) return;
        setError(
          failure instanceof ApiError && failure.status === 401
            ? 'Войдите в аккаунт сотрудника.'
            : 'Не удалось проверить доступ сотрудника.',
        );
      },
    );
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const assuredUntil = state?.assuredUntil;
  useEffect(() => {
    if (!assuredUntil) return;
    const validFor = Date.parse(assuredUntil) - Date.now();
    const timeout = window.setTimeout(
      () => {
        setState((value) =>
          value ? { ...value, assuredUntil: null } : undefined,
        );
      },
      Math.max(validFor, 0),
    );
    return () => window.clearTimeout(timeout);
  }, [assuredUntil]);
  if (state && (!state.required || assuredUntil)) return children;
  const enrolling = state?.enrolled === false;
  return (
    <section className="panel" aria-labelledby="staff-two-factor-heading">
      <h1 id="staff-two-factor-heading">Проверка входа сотрудника</h1>
      {!state && !error && <p role="status">Проверяем доступ…</p>}
      {error && <p role="alert">{error}</p>}
      {!state && error && (
        <div className="actions">
          <Link href="/account">Войти в аккаунт</Link>
          <button
            type="button"
            onClick={() => {
              setError('');
              setLoadAttempt((value) => value + 1);
            }}
          >
            Повторить проверку
          </button>
        </div>
      )}
      {state && !state.available && (
        <p>Обратитесь к администратору для настройки второго фактора.</p>
      )}
      {state?.available && enrolling && !secret && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const password = new FormData(form).get('password');
            form.reset();
            setBusy(true);
            setError('');
            try {
              const result = await api<{ secret: string }>(
                endpoint + 'enroll',
                'POST',
                { password },
              );
              setSecret(result.secret);
            } catch {
              setError(
                'Не удалось начать настройку. Проверьте пароль или повторите позже.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Пароль аккаунта
            <input
              required
              name="password"
              type="password"
              autoComplete="current-password"
            />
          </label>
          <button type="submit" disabled={busy}>
            Настроить второй фактор
          </button>
        </form>
      )}
      {state?.available && (!enrolling || secret) && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const code = new FormData(form).get('code');
            form.reset();
            setBusy(true);
            setError('');
            try {
              await api<void>(
                endpoint + (enrolling ? 'activate' : 'confirm'),
                'POST',
                { code },
              );
              setSecret('');
              setState(undefined);
              setLoadAttempt((value) => value + 1);
            } catch (failure) {
              setError(
                failure instanceof ApiError && failure.status === 429
                  ? 'Слишком много попыток. Повторите через минуту.'
                  : 'Не удалось подтвердить код. Введите новый код из приложения.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {secret && (
            <p>
              Добавьте ключ в приложение-аутентификатор: <code>{secret}</code>
            </p>
          )}
          <label>
            Код из приложения
            <input
              required
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
            />
          </label>
          <button type="submit" disabled={busy}>
            Подтвердить вход
          </button>
          {secret && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSecret('');
                setError('');
              }}
            >
              Начать заново
            </button>
          )}
        </form>
      )}
    </section>
  );
}
