'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@raui/ui';
import { api, ApiError } from '../lib/client';

export default function ListingSubscription({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const [loaded, setLoaded] = useState<{ id: string; version: number } | null>(
    null,
  );
  const version = loaded?.id === id ? loaded.version : null;
  useEffect(() => {
    if (!open) return;
    let current = true;
    api<{ version: number }>('v1/account/listing-subscriptions/' + id)
      .then((value) => {
        if (current) setLoaded({ id, version: value.version });
      })
      .catch((error: Error) => {
        if (current) setNotice(error.message);
      });
    return () => {
      current = false;
    };
  }, [open, id]);
  return (
    <section aria-label="Подписка на объявление">
      <Button
        onClick={() => {
          setLoaded(null);
          setNotice('');
          setOpen((value) => !value);
        }}
        aria-expanded={open}
      >
        Подписаться на изменения
      </Button>
      {open && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current || version === null) return;
            const data = new FormData(event.currentTarget);
            const events = data.getAll('events');
            const channels = data.getAll('channels');
            if (
              !events.length ||
              !channels.length ||
              data.get('consent') !== 'yes'
            ) {
              setNotice('Выберите хотя бы одно событие и канал уведомлений.');
              return;
            }
            lock.current = true;
            setBusy(true);
            setNotice('');
            try {
              const saved = await api<{ version: number }>(
                'v1/account/listing-subscriptions/' + id,
                'POST',
                {
                  events,
                  channels,
                  frequency: data.get('frequency'),
                  consent: true,
                  version,
                },
              );
              setLoaded({ id, version: saved.version });
              setNotice(
                'Настройки подписки сохранены. Доставка зависит от подключения канала и настроек аккаунта.',
              );
            } catch (error) {
              setNotice(
                error instanceof ApiError && error.status === 409
                  ? 'Настройки подписки изменились. Закройте форму, откройте её заново и подтвердите свой выбор.'
                  : (error as Error).message,
              );
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy}>
            <legend>Какие изменения вас интересуют?</legend>
            <label>
              <input
                type="checkbox"
                name="events"
                value="price_drop"
                defaultChecked
              />
              Снижение цены
            </label>
            <label>
              <input
                type="checkbox"
                name="events"
                value="availability"
                defaultChecked
              />
              Изменение доступности
            </label>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Куда получать уведомления?</legend>
            <label>
              <input
                type="checkbox"
                name="channels"
                value="email"
                defaultChecked
              />
              На подтверждённый email
            </label>
          </fieldset>
          <label>
            Частота уведомлений
            <select name="frequency" defaultValue="immediate" disabled={busy}>
              <option value="immediate">По мере изменений</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              name="consent"
              value="yes"
              required
              disabled={busy}
            />
            Согласен получать выбранные уведомления об этом объявлении
          </label>
          <p>
            Подписка не включает рекламную рассылку. Для сохранения нужен вход в
            аккаунт.
          </p>
          <Button type="submit" disabled={busy || version === null}>
            {busy ? 'Сохраняем…' : 'Сохранить подписку'}
          </Button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
