'use client';
import { useEffect, useRef, useState } from 'react';
import { api, money } from '../lib/client';
import { attributeLabels, attributeValue } from '../lib/labels';
type Case = {
  id: string;
  listing_id: string;
  listing_version: number;
  state: string;
};
type Materials = {
  caseId: string;
  listingVersion: number;
  listing: {
    id: string;
    title: string;
    description: string;
    price: number;
    deal_type: string;
    version: number;
  };
  property: {
    address: string;
    category_code: string;
    attributes: Record<string, unknown>;
  };
  media: { id: string; kind: string; state: string }[];
};
type Action = {
  caseId: string;
  decision: 'approve' | 'reject';
  reason: string;
  key: string;
};
export default function ModerationWorkbench() {
  const [queue, setQueue] = useState<Case[]>([]);
  const [materials, setMaterials] = useState<Materials>();
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    const requests = generation;
    api<Case[]>('v1/admin/moderation')
      .then((rows) => {
        if (live) setQueue(rows);
      })
      .catch(() => {
        if (live)
          setError(
            'Не удалось загрузить очередь. Проверьте доступ и обновите страницу.',
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      requests.current++;
    };
  }, []);
  async function open(item: Case) {
    const current = ++generation.current;
    setMaterials(undefined);
    setAction(undefined);
    setReason('');
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const value = await api<Materials>(
        `v1/admin/moderation/${item.id}/materials`,
      );
      if (current === generation.current) {
        if (
          value.caseId !== item.id ||
          value.listingVersion !== item.listing_version ||
          value.listing.version !== value.listingVersion
        )
          throw new Error('stale');
        setMaterials(value);
      }
    } catch {
      if (current === generation.current)
        setError('Материалы недоступны или изменились. Обновите очередь.');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  async function reloadQueue() {
    if (busy) return;
    const current = ++generation.current;
    setMaterials(undefined);
    setAction(undefined);
    setReason('');
    setError('');
    setLoading(true);
    try {
      const rows = await api<Case[]>('v1/admin/moderation');
      if (current === generation.current) setQueue(rows);
    } catch {
      if (current === generation.current) {
        setQueue([]);
        setError(
          'Не удалось загрузить очередь. Проверьте доступ и повторите запрос.',
        );
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  function prepare(decision: Action['decision']) {
    if (!materials || reason.trim().length < 3 || busy) return;
    setError('');
    setAction({
      caseId: materials.caseId,
      decision,
      reason: reason.trim(),
      key: crypto.randomUUID(),
    });
  }
  async function confirm() {
    if (!action || busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      await api(
        `v1/admin/moderation/${action.caseId}/decision`,
        'POST',
        { decision: action.decision, reason: action.reason },
        { idempotencyKey: action.key },
      );
      if (current !== generation.current) return;
      setMaterials(undefined);
      setAction(undefined);
      setReason('');
      setNotice('Решение сохранено.');
      try {
        const rows = await api<Case[]>('v1/admin/moderation');
        if (current === generation.current) setQueue(rows);
      } catch {
        if (current === generation.current) {
          setQueue([]);
          setError(
            'Решение сохранено, но очередь не обновилась. Обновите страницу.',
          );
        }
      }
    } catch {
      if (current === generation.current)
        setError(
          'Решение не подтверждено сервером. Проверьте доступ или повторите запрос.',
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  const warnings: string[] = [];
  if (materials) {
    if (materials.listing.title.trim().length < 3)
      warnings.push('Не указано название.');
    if (
      !Number.isFinite(Number(materials.listing.price)) ||
      Number(materials.listing.price) <= 0
    )
      warnings.push('Проверьте цену.');
    const text = (
      materials.listing.title +
      ' ' +
      materials.listing.description
    ).toLocaleLowerCase('ru');
    if (
      /(?:предоплат|переведите|оплат).{0,80}(?:до\s+просмотр|before\s+viewing)/u.test(
        text,
      ) ||
      /advance payment.{0,50}before viewing/u.test(text)
    )
      warnings.push(
        'Проверьте условия аванса: оплата до просмотра может требовать уточнения.',
      );
    if (
      /(?:паспорт|passport).{0,60}(?:https?:\/\/|телеграм|telegram)/u.test(text)
    )
      warnings.push('Проверьте запрос персональных данных в описании.');
  }
  return (
    <section aria-labelledby="moderation-title">
      <h1 id="moderation-title">Проверка объявлений</h1>
      <p>
        Решения принимает сотрудник. Доступ к проверке и решениям назначает
        администратор.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Загрузка…</p>}
      <button disabled={busy || loading} onClick={() => void reloadQueue()}>
        Обновить очередь
      </button>
      <ul>
        {queue.map((item) => (
          <li key={item.id}>
            <button disabled={busy} onClick={() => void open(item)}>
              Открыть проверку {item.listing_id}, версия {item.listing_version}
            </button>
          </li>
        ))}
      </ul>
      {!loading && !error && queue.length === 0 && (
        <p>Нет объявлений на проверке.</p>
      )}
      {materials && (
        <article>
          <h2>{materials.listing.title || 'Без названия'}</h2>
          <p>Версия {materials.listingVersion}</p>
          <p>{materials.property.address}</p>
          <p>{money(Number(materials.listing.price))}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>
            {materials.listing.description}
          </p>
          <h3>Характеристики объекта</h3>
          <dl>
            {Object.entries(materials.property.attributes)
              .filter(
                ([key, value]) =>
                  Object.hasOwn(attributeLabels, key) &&
                  (typeof value === 'string' ||
                    typeof value === 'boolean' ||
                    (typeof value === 'number' && Number.isFinite(value))),
              )
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{attributeLabels[key]}</dt>
                  <dd>{attributeValue(value)}</dd>
                </div>
              ))}
          </dl>
          <h3>Фотографии</h3>
          {materials.media
            .filter(
              (item) =>
                item.state === 'ready' &&
                ['photo', 'floor_plan'].includes(item.kind),
            )
            .map((item) => (
              <img
                key={item.id}
                src={`/api/v1/admin/moderation/${materials.caseId}/media/${item.id}/small`}
                alt="Фотография объекта для проверки"
                width={320}
              />
            ))}
          {!materials.media.some(
            (item) =>
              item.state === 'ready' &&
              ['photo', 'floor_plan'].includes(item.kind),
          ) && <p>Готовые фотографии отсутствуют.</p>}
          <h3>Помощник проверки</h3>
          <p>
            Подсказки по тексту не подтверждают достоверность объекта. Проверьте
            материалы самостоятельно.
          </p>
          {warnings.length ? (
            <ul>
              {warnings.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p>Текстовые подсказки отсутствуют. Ручная проверка обязательна.</p>
          )}
          <label>
            Причина решения
            <textarea
              value={reason}
              maxLength={2000}
              disabled={busy || !!action}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !!action || reason.trim().length < 3}
            onClick={() => prepare('approve')}
          >
            Одобрить
          </button>
          <button
            disabled={busy || !!action || reason.trim().length < 3}
            onClick={() => prepare('reject')}
          >
            Отклонить
          </button>
          {action && (
            <div role="group" aria-label="Подтверждение решения">
              <p>
                {action.decision === 'approve' ? 'Одобрить' : 'Отклонить'}{' '}
                объявление? Причина: {action.reason}
              </p>
              <button disabled={busy} onClick={() => void confirm()}>
                Подтвердить решение
              </button>
              <button disabled={busy} onClick={() => setAction(undefined)}>
                Отмена
              </button>
            </div>
          )}
        </article>
      )}
    </section>
  );
}
