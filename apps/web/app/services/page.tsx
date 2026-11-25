import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Сервисы — RAUI.RU' };

export default function Services() {
  return (
    <main id="content">
      <h1>Сервисы</h1>
      <div className="cards">
        <section className="panel" id="deals">
          <h2>Сделки и объявления</h2>
          <p>
            Размещайте предложения и следите за статусом объявлений в кабинете.
          </p>
          <Link href="/account/listings">Мои объявления</Link>
        </section>
        <section className="panel">
          <h2>Поиск и избранное</h2>
          <p>Подбирайте объекты на карте и сохраняйте подходящие варианты.</p>
          <div className="actions">
            <Link href="/search?mode=map">Карта недвижимости</Link>
            <Link href="/account">Личный кабинет</Link>
          </div>
        </section>
        <section className="panel" id="mobile">
          <h2>Мобильная версия</h2>
          <p>
            Откройте веб-версию в мобильном браузере. Для быстрого доступа
            добавьте страницу на главный экран через меню браузера.
          </p>
          <Link href="/">На главную</Link>
        </section>
      </div>
    </main>
  );
}
