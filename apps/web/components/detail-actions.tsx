'use client';
import { Button } from '@raui/ui';
import ListingSubscription from './listing-subscription';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, track } from '../lib/client';
import styles from './detail-actions.module.css';
type PublicContact = { messagesAllowed: boolean; phones: string[] };

export default function DetailActions({
  id,
  messagesAllowed,
  callsAllowed,
}: {
  id: string;
  messagesAllowed: boolean;
  callsAllowed: boolean;
}) {
  const [notice, setNotice] = useState(''),
    [sending, setSending] = useState(false);
  const [contact, setContact] = useState<PublicContact | null>(null);
  const [revealing, setRevealing] = useState(false);
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
  async function revealPhones() {
    setRevealing(true);
    try {
      const current = await api<PublicContact>(
        'v1/listings/' + id + '/public/contact',
      );
      setContact(current);
      setNotice(
        current.phones.length
          ? ''
          : 'Продавец отключил звонки по этому объявлению.',
      );
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setRevealing(false);
    }
  }
  return (
    <section className="panel" aria-label="Действия с объявлением">
      <h2>Связаться с продавцом</h2>
      {callsAllowed && !contact && (
        <Button onClick={revealPhones} disabled={revealing}>
          {revealing ? 'Загрузка…' : 'Показать телефон'}
        </Button>
      )}
      {Boolean(contact?.phones.length) && (
        <ul aria-label="Телефоны для связи" className={styles.phones}>
          {contact?.phones.map((phone, index) => (
            <li key={phone}>
              <a
                href={'tel:' + phone}
                onClick={() =>
                  track({ type: 'contact_initiated', listingId: id })
                }
              >
                Телефон {index + 1} ·{' '}
                {phone.replace(
                  /^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/,
                  '$1 $2 $3-$4-$5',
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      {(contact?.messagesAllowed ?? messagesAllowed) && (
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
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="actions">
        <Button onClick={() => collect('favorite')}>В избранное</Button>
        <Button onClick={() => collect('compare')}>Сравнить</Button>
        <Link href="/account">Открыть аккаунт</Link>
      </div>
      <ListingSubscription key={id} id={id} />
    </section>
  );
}
