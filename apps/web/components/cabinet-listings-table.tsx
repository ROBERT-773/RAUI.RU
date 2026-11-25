import type { ReactNode } from 'react';
import { dealLabel, formatListingPrice } from '../lib/labels';
import { listingStatusLabel } from './listing-editor-status';
import styles from './cabinet-listings-table.module.css';

type Row = {
  id: string;
  object: ReactNode;
  price?: string | null | undefined;
  dealType?: string | undefined;
  area?: string | null | undefined;
  floor?: string | null | undefined;
  status: string;
};

export default function CabinetListingsTable({
  label,
  rows,
}: {
  label: string;
  rows: Row[];
}) {
  if (!rows.length) return null;
  return (
    <div className={styles.container}>
      <table className={styles.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Объект и адрес</th>
            <th scope="col" className={styles.detail}>
              Сделка
            </th>
            <th scope="col" className={styles.detail}>
              Площадь, м²
            </th>
            <th scope="col" className={styles.detail}>
              Этаж
            </th>
            <th scope="col">
              Цена<span className={styles.compactStatus}> и статус</span>
            </th>
            <th scope="col" className={styles.statusColumn}>
              Статус
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const deal = dealLabel(row.dealType ?? '') ?? '—';
            return (
              <tr key={row.id}>
                <td>
                  {row.object}
                  <details className={styles.mobile}>
                    <summary>Параметры</summary>
                    <span>{deal}</span>
                    <span>Площадь: {row.area ? row.area + ' м²' : '—'}</span>
                    <span>Этаж: {row.floor ?? '—'}</span>
                  </details>
                </td>
                <td className={styles.detail}>{deal}</td>
                <td className={styles.detail}>{row.area ?? '—'}</td>
                <td className={styles.detail}>{row.floor ?? '—'}</td>
                <td>
                  {row.price == null
                    ? '—'
                    : formatListingPrice(row.price, row.dealType ?? '')}
                  <span className={styles.compactStatus}>
                    {listingStatusLabel(row.status)}
                  </span>
                </td>
                <td className={styles.statusColumn}>
                  {listingStatusLabel(row.status)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
