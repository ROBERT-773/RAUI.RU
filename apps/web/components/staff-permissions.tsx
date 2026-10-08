'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
interface StaffUser {
  id: string;
  email: string;
  display_name: string;
}
type Permission =
  | 'moderation.read'
  | 'moderation.decide'
  | 'registration.read'
  | 'registration.decide';
const labels: Record<Permission, string> = {
  'moderation.read': 'Просмотр очереди модерации',
  'moderation.decide': 'Одобрение и отклонение публикации',
  'registration.read': 'Просмотр заявок на регистрацию',
  'registration.decide': 'Одобрение и отклонение регистрации',
};
export default function StaffPermissions() {
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [target, setTarget] = useState('');
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [permission, setPermission] = useState<Permission>('moderation.read');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true;
    const requests = epoch;
    api<StaffUser[]>('v1/admin/users')
      .then((value) => {
        if (active) {
          setUsers(value);
          setMore(value.length === 100);
        }
      })
      .catch(() => {
        if (active)
          setError(
            'Доступ к управлению разрешениями недоступен. Войдите как администратор.',
          );
      });
    return () => {
      active = false;
      requests.current++;
    };
  }, []);
  async function loadMore() {
    if (!users?.length || loadingUsers) return;
    setLoadingUsers(true);
    try {
      const value = await api<StaffUser[]>(
        `v1/admin/users?after=${users.at(-1)!.id}`,
      );
      setUsers((current) => [...(current ?? []), ...value]);
      setMore(value.length === 100);
    } catch {
      setError('Не удалось загрузить сотрудников. Попробуйте ещё раз.');
    } finally {
      setLoadingUsers(false);
    }
  }
  async function select(id: string) {
    const request = ++epoch.current;
    setTarget(id);
    setPermissions(null);
    setNotice('');
    setError('');
    setReason('');
    if (!id) return;
    try {
      const value = await api<{ permissions: Permission[] }>(
        `v1/admin/users/${id}/permissions`,
      );
      if (request === epoch.current) setPermissions(value.permissions);
    } catch {
      if (request === epoch.current)
        setError('Не удалось получить разрешения сотрудника.');
    }
  }
  async function change(granted: boolean) {
    if (!target || reason.trim().length < 3 || busy) return;
    const request = epoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`v1/admin/users/${target}/permissions`, 'PATCH', {
        permission,
        granted,
        reason: reason.trim(),
      });
      const value = await api<{ permissions: Permission[] }>(
        `v1/admin/users/${target}/permissions`,
      );
      if (request === epoch.current) {
        setPermissions(value.permissions);
        setNotice(granted ? 'Разрешение выдано.' : 'Разрешение отозвано.');
        setReason('');
      }
    } catch {
      if (request === epoch.current)
        setError('Не удалось изменить разрешение. Проверьте актуальные права.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Права сотрудников</h1>
      {error && <p role="alert">{error}</p>}
      {users === null ? (
        !error && <p>Проверяем доступ…</p>
      ) : (
        <>
          <label>
            Сотрудник
            <select
              value={target}
              disabled={busy}
              onChange={(event) => void select(event.target.value)}
            >
              <option value="">Выберите сотрудника</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name} — {user.email}
                </option>
              ))}
            </select>
          </label>
          {more && (
            <button
              disabled={loadingUsers || busy}
              onClick={() => void loadMore()}
            >
              Загрузить ещё сотрудников
            </button>
          )}
          {target && permissions !== null && (
            <>
              <p>Выданные разрешения:</p>
              {permissions.length ? (
                <ul>
                  {permissions.map((value) => (
                    <li key={value}>{labels[value]}</li>
                  ))}
                </ul>
              ) : (
                <p>Нет выданных разрешений.</p>
              )}
              <label>
                Разрешение
                <select
                  value={permission}
                  disabled={busy}
                  onChange={(event) =>
                    setPermission(event.target.value as Permission)
                  }
                >
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Причина изменения
                <textarea
                  value={reason}
                  minLength={3}
                  maxLength={2000}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                disabled={busy || reason.trim().length < 3}
                onClick={() => void change(true)}
              >
                Выдать разрешение
              </button>
              <button
                disabled={busy || reason.trim().length < 3}
                onClick={() => void change(false)}
              >
                Отозвать разрешение
              </button>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}
