'use client';
import { Button } from '@raui/ui';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, track } from '../lib/client';
export default function DetailActions({ id }: { id: string }) {
  const [notice, setNotice] = useState(''),
    [sending, setSending] = useState(false);
  useEffect(() => {
    track({ type: 'listing_viewed', listingId: id });
    void api('v1/account/collections/recent', 'POST', { listingId: id }).catch(
      () => {},
    );
  }, [id]);
  async function collect(kind: 'favorite' | 'compare') {
    try {
      await api('v1/account/collections/' + kind, 'POST', { listingId: id });
      setNotice(
        kind === 'favorite'
          ? 'Добавлено в избранное.'
          : 'Добавлено в сравнение.',
      );
      if (kind === 'favorite') track({ type: 'favorite_added', listingId: id });
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  return (
    <section className="panel" aria-label="Действия с объявлением">
      <div className="actions">
        <Button onClick={() => collect('favorite')}>В избранное</Button>
        <Button onClick={() => collect('compare')}>Сравнить</Button>
        <Link href="/account">Открыть аккаунт</Link>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (sending) return;
          setSending(true);
          const form = e.currentTarget;
          try {
            await api('v1/account/inquiries/' + id, 'POST', {
              body: new FormData(form).get('message'),
            });
            setNotice('Сообщение отправлено. Переписка доступна в аккаунте.');
            track({ type: 'contact_initiated', listingId: id });
            form.reset();
          } catch (error) {
            setNotice((error as Error).message);
          } finally {
            setSending(false);
          }
        }}
      >
        <label>
          Сообщение продавцу
          <textarea name="message" required maxLength={4000} rows={4} />
        </label>
        <Button type="submit" disabled={sending}>
          {sending ? 'Отправляем…' : 'Отправить сообщение'}
        </Button>
      </form>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
