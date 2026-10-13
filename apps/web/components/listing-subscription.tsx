'use client';
import { useRef, useState } from 'react';
import { Button } from '@raui/ui';
import { api } from '../lib/client';

export default function ListingSubscription({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  return (
    <section aria-label="Подписка на объявление">
      <Button onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        Подписаться на изменения
      </Button>
      {open && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current) return;
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
              await api('v1/account/listing-subscriptions/' + id, 'POST', {
                events,
                channels,
                frequency: data.get('frequency'),
                consent: true,
              });
              setNotice(
                'Настройки подписки сохранены. Доставка зависит от подключения канала и настроек аккаунта.',
              );
            } catch (error) {
              setNotice((error as Error).message);
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
                value="in_app"
                defaultChecked
              />
              В аккаунте
            </label>
            <label>
              <input type="checkbox" name="channels" value="email" />
              На подтверждённый email
            </label>
          </fieldset>
          <label>
            Частота уведомлений
            <select name="frequency" defaultValue="daily" disabled={busy}>
              <option value="daily">Ежедневная подборка</option>
              <option value="immediate">Сразу</option>
            </select>
          </label>
          <p>
            Ежедневная подборка пока недоступна. Для уведомлений в аккаунте
            выберите «Сразу» и канал «В аккаунте».
          </p>
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
          <Button type="submit" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить подписку'}
          </Button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
