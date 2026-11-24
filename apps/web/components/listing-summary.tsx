'use client';

import { Button } from '@raui/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import styles from './listing-summary.module.css';

const labels = { total: 'Всего', sale: 'Продажа', rent: 'Аренда' } as const;
type Metric = keyof typeof labels;
type Counts = Record<Metric, number>;
const metrics: Metric[] = ['total', 'sale', 'rent'];
const number = new Intl.NumberFormat('ru-RU');

export default function ListingSummary() {
  const [counts, setCounts] = useState<Counts | 'loading' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api<Counts>('v1/listings/summary')
      .then((result) => {
        if (!active) return;
        const valid = metrics.every(
          (key) => Number.isSafeInteger(result?.[key]) && result[key] >= 0,
        );
        setCounts(valid ? result : 'error');
      })
      .catch(() => {
        if (active) setCounts('error');
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <section className={`panel ${styles.summary}`} aria-label="Мои объявления">
      <h2>
        <Link href="/account/listings">Мои объявления</Link>
      </h2>
      {counts === 'loading' ? (
        <p role="status">Загрузка счётчиков…</p>
      ) : counts === 'error' ? (
        <>
          <p role="alert">Не удалось загрузить счётчики объявлений.</p>
          <Button
            onClick={() => {
              setCounts('loading');
              setAttempt((value) => value + 1);
            }}
          >
            Повторить загрузку
          </Button>
        </>
      ) : (
        <>
          <dl className={styles.metrics}>
            {metrics.map((key) => (
              <div key={key}>
                <dt>{labels[key]}</dt>
                <dd>{number.format(counts[key])}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>Все статусы, включая черновики и архив.</p>
        </>
      )}
    </section>
  );
}
