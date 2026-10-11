'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@raui/ui';
import { api } from '../lib/client';

interface Subscription {
  listing_id: string;
  events: string[];
  channels: string[];
  frequency: string;
  version: number;
}
export default function AccountSubscriptions() {
  const [items, setItems] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    let current = true;
    active.current = true;
    api<Subscription[]>('v1/account/listing-subscriptions')
      .then((value) => {
        if (current) setItems(value);
      })
      .catch((reason: Error) => {
        if (current) setError(reason.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      active.current = false;
    };
  }, []);
  async function disable(item: Subscription) {
    if (lock.current) return;
    lock.current = true;
    setBusy(item.listing_id);
    setError('');
    try {
      await api(
        `v1/account/listing-subscriptions/${item.listing_id}/disable`,
        'POST',
        { version: item.version },
      );
      if (active.current)
        setItems((previous) =>
          previous.filter((row) => row.listing_id !== item.listing_id),
        );
    } catch (reason) {
      if (active.current) setError((reason as Error).message);
    } finally {
      lock.current = false;
      if (active.current) setBusy('');
    }
  }
  return (
    <section aria-label="Подписки на объявления">
      <h2>Подписки на объявления</h2>
      <p>Подписки на изменения объектов не включают рекламную рассылку.</p>
      {loading && <p role="status">Загружаем подписки…</p>}
      {!loading && !error && !items.length && (
        <p>
          Подписок пока нет. Выберите «Подписаться на изменения» на странице
          интересующего объявления.
        </p>
      )}
      {items.map((item) => (
        <article className="panel" key={item.listing_id}>
          <Link href={'/listings/' + item.listing_id}>Открыть объявление</Link>
          <p>
            События:{' '}
            {item.events
              .map((event) =>
                event === 'price_drop'
                  ? 'снижение цены'
                  : 'изменение доступности',
              )
              .join(', ')}
          </p>
          <p>
            Каналы:{' '}
            {item.channels
              .map((channel) => (channel === 'email' ? 'email' : 'в аккаунте'))
              .join(', ')}
          </p>
          <p>
            Частота:{' '}
            {item.frequency === 'daily'
              ? 'ежедневная подборка'
              : 'по мере изменений'}
          </p>
          <Button disabled={Boolean(busy)} onClick={() => void disable(item)}>
            {busy === item.listing_id ? 'Отключаем…' : 'Отключить подписку'}
          </Button>
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
