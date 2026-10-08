'use client';
import { Button } from '@raui/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
interface Profile {
  email: string;
  phone: string | null;
  role: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  registration_approval_state: 'pending' | 'approved' | 'rejected';
  registration_approval_reason: string | null;
}
const roles: Record<string, string> = {
  buyer: 'Покупатель / арендатор',
  owner: 'Собственник',
  agent: 'Агент',
  agency: 'Агентство',
  developer: 'Застройщик',
  admin: 'Администратор',
};
export default function AccountProfile({
  onRefresh,
  onSessionExpired,
}: {
  onRefresh?: () => void;
  onSessionExpired?: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const generation = useRef(0),
    lock = useRef(false),
    refreshCallback = useRef(onRefresh),
    expiredCallback = useRef(onSessionExpired);
  useEffect(() => {
    refreshCallback.current = onRefresh;
    expiredCallback.current = onSessionExpired;
  }, [onRefresh, onSessionExpired]);
  useEffect(() => {
    const epoch = generation;
    const current = ++epoch.current;
    api<Profile>('v1/auth/me')
      .then((value) => {
        if (current === generation.current) setProfile(value);
      })
      .catch((e) => {
        if (current === generation.current) {
          setError((e as Error).message);
          if (e instanceof Error && 'status' in e && e.status === 401)
            expiredCallback.current?.();
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      epoch.current++;
    };
  }, []);
  async function action(path?: string, body?: unknown, confirm = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const current = generation.current;
    try {
      if (path) await api(path, 'POST', body);
      if (current !== generation.current) return;
      if (!path || confirm) {
        const value = await api<Profile>('v1/auth/me');
        if (current !== generation.current) return;
        setProfile(value);
        refreshCallback.current?.();
        const verifiedContact =
          path === 'v1/auth/verification/email/confirm'
            ? value.email_verified_at
            : value.phone_verified_at;
        setNotice(
          !confirm
            ? 'Профиль обновлён.'
            : verifiedContact
              ? 'Контакт подтверждён.'
              : 'Запрос обработан. Проверьте статус контакта в профиле.',
        );
      } else
        setNotice(
          'Запрос принят. Дождитесь сообщения; принятие запроса не подтверждает доставку.',
        );
    } catch (e) {
      if (current === generation.current) {
        setError((e as Error).message);
        if (e instanceof Error && 'status' in e && e.status === 401)
          expiredCallback.current?.();
      }
    } finally {
      if (current === generation.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="panel" aria-label="Профиль и подтверждение контактов">
      <h2>Профиль</h2>
      {loading && <p role="status">Загружаем профиль…</p>}
      {profile && (
        <>
          <p>Роль: {roles[profile.role] ?? profile.role}</p>
          <p>
            {profile.registration_approval_state === 'pending'
              ? 'Ожидает одобрения сотрудника'
              : profile.registration_approval_state === 'rejected'
                ? 'Регистрация отклонена'
                : 'Регистрация одобрена'}
          </p>
          {profile.registration_approval_reason && (
            <p>{profile.registration_approval_reason}</p>
          )}
          {profile.registration_approval_state === 'pending' && (
            <p>
              Подтвердите email и телефон. Проверка контактов не заменяет
              решение сотрудника.
            </p>
          )}
          <h3>Email</h3>
          <p>{profile.email}</p>
          <p>{profile.email_verified_at ? 'Подтверждён' : 'Не подтверждён'}</p>
          <Button
            disabled={busy}
            onClick={() => void action('v1/auth/verification/email')}
          >
            Запросить подтверждение email
          </Button>
          <h3>Телефон</h3>
          <p>{profile.phone ?? 'Не указан'}</p>
          <p>{profile.phone_verified_at ? 'Подтверждён' : 'Не подтверждён'}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action('v1/auth/verification/phone', {
                phone: new FormData(e.currentTarget).get('phone'),
              });
            }}
          >
            <label>
              Номер телефона
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                placeholder="+79991234567"
                pattern="\+[1-9][0-9]{7,14}"
                required
                disabled={busy}
              />
            </label>
            <p>Международный формат: + и от 8 до 15 цифр.</p>
            <Button type="submit" disabled={busy}>
              Запросить подтверждение телефона
            </Button>
          </form>
          <p>
            Вставьте код подтверждения из полученного сообщения. Если сообщение
            не пришло, повторите запрос позже.
          </p>
          {(['email', 'phone'] as const).map((channel) => (
            <form
              key={channel}
              onSubmit={(e) => {
                e.preventDefault();
                void action(
                  'v1/auth/verification/' + channel + '/confirm',
                  { token: new FormData(e.currentTarget).get('token') },
                  true,
                );
              }}
            >
              <label>
                Код подтверждения {channel === 'email' ? 'email' : 'телефона'}{' '}
                из сообщения
                <input
                  name="token"
                  minLength={43}
                  maxLength={43}
                  pattern="[A-Za-z0-9_-]{43}"
                  required
                  disabled={busy}
                  autoComplete="off"
                />
              </label>
              <Button type="submit" disabled={busy}>
                Подтвердить {channel === 'email' ? 'email' : 'телефон'}
              </Button>
            </form>
          ))}
        </>
      )}
      <Button disabled={busy || loading} onClick={() => void action()}>
        Обновить профиль
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
