'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/client';

type Role = 'admin' | 'member';
type Member = {
  user_id: string;
  display_name: string;
  role: Role | 'owner';
  active: boolean;
};
const labels = {
  owner: 'Владелец',
  admin: 'Администратор',
  member: 'Сотрудник',
};

export default function AgencyMembers({
  agencyId,
  userId,
  role,
}: {
  agencyId: string;
  userId: string;
  role: string;
}) {
  const path = `v1/organizations/${agencyId}/members`;
  const [members, setMembers] = useState<Member[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const canManage = role === 'owner' || role === 'admin';

  useEffect(() => {
    let current = true;
    api<Member[]>(path)
      .then((items) => {
        if (current) setMembers(items);
      })
      .catch(() => {
        if (current) setError('Не удалось загрузить сотрудников.');
      });
    return () => {
      current = false;
    };
  }, [path]);

  async function save(targetId: string, nextRole: Role, active: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, 'PATCH', { userId: targetId, role: nextRole, active });
      setCode('');
      try {
        setMembers(await api<Member[]>(path));
        setNotice('Изменения сохранены.');
      } catch {
        setError(
          'Изменения сохранены. Обновите страницу, чтобы увидеть список.',
        );
        setMembers(undefined);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Не удалось сохранить изменения.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Сотрудники агентства">
      <h3>Сотрудники</h3>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!members && !error && <p role="status">Загружаем сотрудников…</p>}
      {members && (
        <ul>
          {members.map((member) => {
            const canEdit =
              canManage &&
              member.user_id !== userId &&
              (member.role === 'member' ||
                (role === 'owner' && member.role === 'admin'));
            return (
              <li key={member.user_id}>
                <strong>{member.display_name}</strong> · {labels[member.role]}
                {!member.active && ' · Доступ отключён'}
                {canEdit && member.role !== 'owner' && (
                  <div className="actions">
                    {role === 'owner' && member.active && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void save(
                            member.user_id,
                            member.role === 'admin' ? 'member' : 'admin',
                            true,
                          )
                        }
                      >
                        {member.role === 'admin'
                          ? 'Назначить сотрудником'
                          : 'Назначить администратором'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void save(
                          member.user_id,
                          member.role === 'admin' ? 'admin' : 'member',
                          !member.active,
                        )
                      }
                    >
                      {member.active
                        ? 'Отключить доступ'
                        : 'Восстановить доступ сотрудника'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && members && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const targetId = code.trim().toLowerCase();
            if (members.some((member) => member.user_id === targetId)) {
              setError(
                'Пользователь уже есть в списке сотрудников. Управляйте доступом в списке.',
              );
              return;
            }
            void save(targetId, 'member', true);
          }}
        >
          <label>
            Код пользователя
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={36}
              pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
              disabled={busy}
            />
          </label>
          <p>
            Попросите сотрудника прислать код из личного кабинета. Для
            добавления ему нужно подтвердить почту и телефон.
          </p>
          <button disabled={busy}>Добавить сотрудника</button>
        </form>
      )}
    </section>
  );
}
