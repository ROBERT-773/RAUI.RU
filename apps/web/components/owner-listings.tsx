'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { api } from '../lib/client';
import NewListing from './new-listing';
interface Listing {
  id: string;
  title: string;
  price: string | null;
  description: string;
  status: string;
  version: number;
  deal_type: string;
}
interface PublicationQuota {
  applies: boolean;
  limit: number | null;
  publishedObjects: number | null;
  remaining: number | null;
}
interface Media {
  id: string;
  kind: string;
  state: string;
}
interface History {
  action: string;
  after: { reason?: string };
}
const imageExtensions: Record<string, RegExp> = {
  'image/jpeg': /\.(jpg|jpeg)$/i,
  'image/png': /\.png$/i,
  'image/webp': /\.webp$/i,
};
const states: Record<string, string> = {
  draft: 'Черновик',
  processing: 'Подготовка к проверке',
  moderation: 'На модерации',
  published: 'Опубликовано',
  paused: 'Приостановлено',
  rejected: 'Отклонено',
  archived: 'В архиве',
  sold: 'Продано',
  rented: 'Сдано',
};
export default function OwnerListings() {
  const [allowed, setAllowed] = useState(false),
    [checking, setChecking] = useState(true);
  const [items, setItems] = useState<Listing[]>([]),
    [more, setMore] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null),
    [media, setMedia] = useState<Media[]>([]),
    [reason, setReason] = useState('');
  const [title, setTitle] = useState(''),
    [price, setPrice] = useState(''),
    [description, setDescription] = useState('');
  const [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [owner, setOwner] = useState(false);
  const [quota, setQuota] = useState<PublicationQuota | null>(null);
  const [quotaError, setQuotaError] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const quotaGeneration = useRef(0);
  const identityGeneration = useRef(0);
  const [creating, setCreating] = useState(false);
  const [uploadPending, setUploadPending] = useState(false);
  const epoch = useRef(0),
    mounted = useRef(true),
    acting = useRef(false);
  const transitionKeys = useRef(new Map<string, string>());
  const upload = useRef<{
    listingId: string;
    file: File;
    key: string;
    base64?: string;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    const identity = ++identityGeneration.current;
    void (async () => {
      try {
        const user = await api<{
          role: string;
          email_verified_at: string | null;
          phone_verified_at: string | null;
          registration_approval_state?: string;
        }>('v1/auth/me');
        if (!mounted.current || identity !== identityGeneration.current) return;
        const eligible =
          (!user.registration_approval_state ||
            user.registration_approval_state === 'approved') &&
          ['owner', 'agent', 'agency', 'developer', 'admin'].includes(
            user.role,
          ) &&
          Boolean(user.email_verified_at && user.phone_verified_at);
        setAllowed(eligible);
        if (!eligible) {
          setError(
            user.registration_approval_state === 'pending'
              ? 'Дождитесь одобрения регистрации сотрудником.'
              : 'Подтвердите email и телефон и используйте кабинет продавца для размещения.',
          );
          return;
        }
        setOwner(user.role === 'owner');
        if (user.role === 'owner') void refreshQuota();
        const value = await api<Listing[]>('v1/listings?limit=20');
        if (mounted.current && identity === identityGeneration.current) {
          setItems(value);
          setMore(value.length === 20);
        }
      } catch (e) {
        if (mounted.current && identity === identityGeneration.current)
          setError(
            e instanceof Error ? e.message : 'Не удалось загрузить объявления.',
          );
      } finally {
        if (mounted.current && identity === identityGeneration.current)
          setChecking(false);
      }
    })();
    const requests = epoch,
      identities = identityGeneration,
      quotaRequests = quotaGeneration;
    return () => {
      mounted.current = false;
      identities.current++;
      quotaRequests.current++;
      requests.current++;
    };
  }, []);
  async function refreshQuota() {
    const request = ++quotaGeneration.current;
    const identity = identityGeneration.current;
    setQuotaLoading(true);
    setQuotaError(false);
    setQuota(null);
    try {
      const value = await api<PublicationQuota>('v1/account/publication-quota');
      if (
        !mounted.current ||
        request !== quotaGeneration.current ||
        identity !== identityGeneration.current
      )
        return;
      setQuota(value);
    } catch (e) {
      if (
        !mounted.current ||
        request !== quotaGeneration.current ||
        identity !== identityGeneration.current
      )
        return;
      if (e instanceof Error && 'status' in e && e.status === 401) {
        setAllowed(false);
        setOwner(false);
        setError(e.message);
      } else setQuotaError(true);
    } finally {
      if (
        mounted.current &&
        request === quotaGeneration.current &&
        identity === identityGeneration.current
      )
        setQuotaLoading(false);
    }
  }
  function assign(value: Listing) {
    if (!mounted.current) return;
    setListing(value);
    setTitle(value.title);
    setPrice(value.price ?? '');
    setDescription(value.description);
    setItems((current) =>
      current.map((item) => (item.id === value.id ? value : item)),
    );
  }
  async function open(id: string) {
    const request = ++epoch.current;
    setLoading(true);
    setListing(null);
    setMedia([]);
    setReason('');
    setError('');
    setNotice('');
    upload.current = null;
    setUploadPending(false);
    try {
      const [value, photos, history] = await Promise.all([
        api<Listing>(`v1/listings/${id}`),
        api<Media[]>(`v1/media/listing/${id}`),
        api<History[]>(`v1/listings/${id}/history`),
      ]);
      if (request !== epoch.current || !mounted.current) return;
      assign(value);
      setMedia(photos);
      setReason(
        history.filter((item) => item.action === 'moderation.decided').at(-1)
          ?.after.reason ?? '',
      );
    } catch {
      if (request === epoch.current)
        setError(
          'Не удалось открыть объявление. Обновите список и попробуйте ещё раз.',
        );
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }
  async function refresh(id: string) {
    const [value, photos] = await Promise.all([
      api<Listing>(`v1/listings/${id}`),
      api<Media[]>(`v1/media/listing/${id}`),
    ]);
    return { value, photos };
  }
  async function run(action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : 'Не удалось выполнить действие.',
        );
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadMore() {
    await run(async () => {
      const value = await api<Listing[]>(
        `v1/listings?limit=20&after=${items.at(-1)!.id}`,
      );
      if (mounted.current) {
        setItems((current) => [
          ...current,
          ...value.filter((item) => !current.some((old) => old.id === item.id)),
        ]);
        setMore(value.length === 20);
      }
    });
  }
  function key(value: Listing, status: string) {
    const id = `${value.id}:${value.version}:${status}`;
    if (!transitionKeys.current.has(id))
      transitionKeys.current.set(id, crypto.randomUUID());
    return transitionKeys.current.get(id)!;
  }
  async function transition(value: Listing, status: string) {
    const updated = await api<Listing>(
      `v1/listings/${value.id}/transitions`,
      'POST',
      { version: value.version, status },
      { idempotencyKey: key(value, status) },
    );
    if (
      mounted.current &&
      owner &&
      value.status === 'published' &&
      updated.status !== 'published'
    )
      await refreshQuota();
    return updated;
  }
  const editable =
    listing && ['draft', 'paused', 'rejected'].includes(listing.status);
  const dirty =
    listing &&
    (title !== listing.title ||
      price !== (listing.price ?? '') ||
      description !== listing.description);
  const ready =
    media.length > 0 && media.every((item) => item.state === 'ready');
  return (
    <section>
      <h1>Мои объявления</h1>
      <Link href="/account">Вернуться в аккаунт</Link>
      {!checking && !allowed && (
        <p>
          <Link href="/account">Профиль и подтверждение контактов</Link>
        </p>
      )}
      {checking && <p>Проверяем доступ…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {allowed && (
        <>
          {owner && quota?.applies !== false && (
            <section className="panel" aria-label="Лимит публикации объектов">
              <h2>Лимит публикации объектов</h2>
              {quotaLoading && <p role="status">Загружаем лимит публикации…</p>}
              {quota?.applies && (
                <p>
                  Опубликовано объектов: {quota.publishedObjects} из{' '}
                  {quota.limit}. Свободных мест: {quota.remaining}.
                </p>
              )}
              {quota?.applies && quota.publishedObjects! >= quota.limit! && (
                <p>
                  Лимит новых объектов достигнут. Уже опубликованные объявления
                  сохраняются.
                </p>
              )}
              {quotaError && (
                <p role="alert">
                  Не удалось загрузить лимит публикации. Обновите данные.
                </p>
              )}
              <p>
                Несколько опубликованных объявлений одного объекта занимают одно
                место. Чтобы освободить место, приостановите все опубликованные
                объявления одного объекта.
              </p>
              <p>
                Если одобрение не прошло из-за лимита, заявка остаётся на
                модерации. После освобождения места сотрудник может повторить
                одобрение той же заявки. Отправлять её заново не нужно.
              </p>
              <p>
                Создавать и редактировать черновики, добавлять фотографии и
                отправлять объявления на модерацию можно и при достигнутом
                лимите.
              </p>
              <button
                type="button"
                disabled={quotaLoading}
                onClick={() => void refreshQuota()}
              >
                Обновить лимит публикации
              </button>
            </section>
          )}
          <NewListing
            onBusyChange={(value) => {
              if (mounted.current) setCreating(value);
            }}
            disabled={busy || loading || Boolean(dirty)}
            onCreated={(id) =>
              void run(async () => {
                const value = await api<Listing[]>('v1/listings?limit=20');
                if (!mounted.current) return;
                setItems(value);
                setMore(value.length === 20);
                await open(id);
              })
            }
          />
          <h2>Сохранённые объявления</h2>
          {!items.length && !checking && <p>Объявлений пока нет.</p>}
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  disabled={busy || creating || loading || Boolean(dirty)}
                  onClick={() => void open(item.id)}
                >
                  {item.title || 'Без названия'}
                </button>{' '}
                — {states[item.status] ?? item.status}
              </li>
            ))}
          </ul>
          {more && (
            <button disabled={busy || creating} onClick={() => void loadMore()}>
              Показать ещё объявления
            </button>
          )}
          {loading && <p role="status">Загружаем объявление…</p>}
          {listing && (
            <article className="panel">
              <h2>{listing.title || 'Черновик объявления'}</h2>
              <p>Статус: {states[listing.status] ?? listing.status}</p>
              {listing.status === 'rejected' && reason && (
                <p role="status">Причина отклонения: {reason}</p>
              )}
              {listing.status === 'published' && (
                <>
                  <Link href={`/listings/${listing.id}`}>
                    Открыть опубликованное объявление
                  </Link>
                  <p>Для редактирования сначала приостановите размещение.</p>
                  <button
                    disabled={busy || creating}
                    onClick={() =>
                      void run(async () => {
                        assign(await transition(listing, 'paused'));
                        if (mounted.current)
                          setNotice('Размещение приостановлено.');
                      })
                    }
                  >
                    Приостановить
                  </button>
                </>
              )}
              {editable && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const updated = await api<Listing>(
                        `v1/listings/${listing.id}`,
                        'PATCH',
                        {
                          version: listing.version,
                          title: title.trim(),
                          price: Number(price),
                          description,
                        },
                      );
                      assign(updated);
                      if (mounted.current) setNotice('Изменения сохранены.');
                    });
                  }}
                >
                  <fieldset disabled={busy || creating}>
                    <legend>Условия предложения</legend>
                    <label>
                      Название
                      <input
                        required
                        minLength={3}
                        maxLength={200}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </label>
                    <label>
                      Цена, ₽
                      <input
                        required
                        type="number"
                        min="0.01"
                        max="99999999999999"
                        step="0.01"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                      />
                    </label>
                    <label>
                      Описание
                      <textarea
                        maxLength={10000}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </label>
                    <button type="submit">Сохранить изменения</button>
                    {dirty && (
                      <button type="button" onClick={() => assign(listing)}>
                        Отменить несохранённые изменения
                      </button>
                    )}
                  </fieldset>
                </form>
              )}
              <h3>Фотографии</h3>
              <p>
                JPEG, PNG или WebP, до 10 МБ. После загрузки дождитесь
                обработки.
              </p>
              <ul>
                {media.map((item) => (
                  <li key={item.id}>
                    {item.state === 'ready' ? (
                      <Image
                        unoptimized
                        src={`/api/v1/media/${item.id}/small`}
                        width={240}
                        height={180}
                        alt="Фотография объекта"
                      />
                    ) : item.state === 'failed' ? (
                      'Ошибка обработки фотографии'
                    ) : (
                      'Фотография обрабатывается'
                    )}
                  </li>
                ))}
              </ul>
              {editable && (
                <label>
                  Добавить фотографию
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={
                      busy || creating || Boolean(dirty) || uploadPending
                    }
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      void run(async () => {
                        if (
                          file.name.length > 200 ||
                          !imageExtensions[file.type]?.test(file.name) ||
                          file.size === 0 ||
                          file.size > 10 * 1024 * 1024 ||
                          !['image/jpeg', 'image/png', 'image/webp'].includes(
                            file.type,
                          ) ||
                          !/^([^/\\]+)\.(jpg|jpeg|png|webp)$/i.test(file.name)
                        )
                          throw new Error(
                            'Выберите JPEG, PNG или WebP размером до 10 МБ.',
                          );
                        upload.current = {
                          listingId: listing.id,
                          file,
                          key: crypto.randomUUID(),
                        };
                        setUploadPending(true);
                        await sendPhoto();
                      });
                    }}
                  />
                </label>
              )}
              {uploadPending && editable && (
                <button
                  disabled={busy || creating || Boolean(dirty)}
                  onClick={() => void run(sendPhoto)}
                >
                  Повторить загрузку фотографии
                </button>
              )}
              <button
                disabled={busy || creating || Boolean(dirty)}
                onClick={() =>
                  void run(async () => {
                    const result = await refresh(listing.id);
                    if (owner && mounted.current) await refreshQuota();
                    assign(result.value);
                    if (!mounted.current) return;
                    setMedia(result.photos);
                    setNotice('Состояние обновлено.');
                  })
                }
              >
                Обновить состояние
              </button>
              {['draft', 'paused', 'rejected', 'processing'].includes(
                listing.status,
              ) && (
                <>
                  {!ready && (
                    <p>
                      Для отправки нужна хотя бы одна обработанная фотография и
                      отсутствие ошибок обработки.
                    </p>
                  )}
                  {dirty && <p>Сохраните изменения перед отправкой.</p>}
                  <button
                    disabled={busy || creating || !ready || Boolean(dirty)}
                    onClick={() =>
                      void run(async () => {
                        let current = (await refresh(listing.id)).value;
                        if (
                          ['draft', 'paused', 'rejected'].includes(
                            current.status,
                          )
                        )
                          current = await transition(current, 'processing');
                        if (!mounted.current) return;
                        if (current.status !== 'processing')
                          throw new Error(
                            'Статус изменился. Обновите объявление.',
                          );
                        const submitted = await transition(
                          current,
                          'moderation',
                        );
                        if (!mounted.current) return;
                        assign(submitted);
                        setNotice(
                          'Объявление отправлено на модерацию. Оно появится после одобрения.',
                        );
                      })
                    }
                  >
                    Отправить на модерацию
                  </button>
                </>
              )}
            </article>
          )}
        </>
      )}
    </section>
  );
  async function sendPhoto() {
    const pending = upload.current;
    if (!pending) return;
    if (!pending.base64)
      pending.base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.readAsDataURL(pending.file);
      });
    await api(
      'v1/media',
      'POST',
      {
        listingId: pending.listingId,
        filename: pending.file.name,
        mime: pending.file.type,
        base64: pending.base64,
      },
      { idempotencyKey: pending.key },
    );
    upload.current = null;
    if (mounted.current) setUploadPending(false);
    const result = await refresh(pending.listingId);
    if (mounted.current) {
      assign(result.value);
      setMedia(result.photos);
      setNotice('Фотография загружена и ожидает обработки.');
    }
  }
}
