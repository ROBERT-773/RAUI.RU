'use client';
import { useRef, useState } from 'react';
import { Button } from '@raui/ui';
import { AccountEntryLink } from './account-entry-link';
import { api, ApiError } from '../lib/client';

type SubscriptionSettings = {
  version: number;
  enabled?: boolean;
  events?: string[];
  channels?: string[];
  frequency?: 'daily' | 'immediate';
};

export default function ListingSubscription({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState<SubscriptionSettings | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const lock = useRef(false);
  const endpoint = 'v1/account/listing-subscriptions/' + id;
  async function loadSettings() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setSettings(null);
    setNotice('');
    setNeedsLogin(false);
    try {
      setSettings(await api<SubscriptionSettings>(endpoint));
    } catch (error) {
      setNeedsLogin(error instanceof ApiError && error.status === 401);
      setNotice((error as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Подписка на объявление">
      <Button
        onClick={() => {
          setOpen(!open);
          setNotice('');
          if (!open) void loadSettings();
        }}
        disabled={busy}
        aria-expanded={open}
      >
        Подписаться на изменения
      </Button>
      {open &&
        !settings &&
        (busy ? (
          <p role="status">Загружаем настройки подписки…</p>
        ) : needsLogin ? (
          <AccountEntryLink href="/account">Войти в кабинет</AccountEntryLink>
        ) : (
          <Button onClick={() => void loadSettings()}>
            Обновить настройки
          </Button>
        ))}
      {open && settings && (
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
              await api(endpoint, 'POST', {
                events,
                channels,
                frequency: data.get('frequency'),
                consent: true,
                version: settings.version,
              });
              setOpen(false);
              setSettings(null);
              setNotice(
                'Настройки подписки сохранены. Доставка зависит от подключения канала и настроек аккаунта.',
              );
            } catch (error) {
              if (error instanceof ApiError && error.status === 409) {
                setSettings(null);
                setNotice(
                  'Подписка изменилась в другой вкладке. Обновите настройки и подтвердите выбор ещё раз.',
                );
              } else setNotice((error as Error).message);
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          {settings.enabled === false && (
            <p>
              Подписка отключена. Чтобы возобновить её, выберите уведомления и
              подтвердите согласие.
            </p>
          )}
          <fieldset disabled={busy}>
            <legend>Какие изменения вас интересуют?</legend>
            <label>
              <input
                type="checkbox"
                name="events"
                value="price_drop"
                defaultChecked={settings.events?.includes('price_drop') ?? true}
              />
              Снижение цены
            </label>
            <label>
              <input
                type="checkbox"
                name="events"
                value="availability"
                defaultChecked={
                  settings.events?.includes('availability') ?? true
                }
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
                defaultChecked={settings.channels?.includes('in_app') ?? true}
              />
              В аккаунте
            </label>
            <label>
              <input
                type="checkbox"
                name="channels"
                value="email"
                defaultChecked={settings.channels?.includes('email') ?? false}
              />
              На подтверждённый email
            </label>
          </fieldset>
          <label>
            Частота уведомлений
            <select
              name="frequency"
              defaultValue={settings.frequency ?? 'daily'}
              disabled={busy}
            >
              <option value="daily">Ежедневная подборка</option>
              <option value="immediate">Сразу</option>
            </select>
          </label>
          <p>
            Ежедневная подборка доступна в аккаунте: выберите канал «В
            аккаунте». Изменения появятся после очередного ежедневного выпуска.
            Ежедневная подборка по email пока недоступна. Для email выберите
            «Сразу»; доставка зависит от подключения канала и настроек аккаунта.
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
