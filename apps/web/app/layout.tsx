import { headers } from 'next/headers';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import './site-header.css';
import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { catalogNavigation } from '../lib/catalog-links';
export const metadata: Metadata = {
  title: 'RAUI.RU',
  description: 'Портал недвижимости',
};
export default async function Layout({ children }: { children: ReactNode }) {
  await headers(); // Request-scoped rendering lets Next apply the CSP nonce to hydration scripts.
  return (
    <html lang="ru">
      <body id="page-top">
        <a className="skip" href="#content">
          К содержимому
        </a>
        <header className="site-header">
          {/* Use native fragment navigation when returning from the homepage map. */}
          <a href="/#page-top" aria-label="RAUI.RU — главная">
            <Image src="/raui-logo.png" alt="" width={116} height={49} />
          </a>
          <nav aria-label="Основная навигация">
            <Link href="/search">Недвижимость</Link>
            <Link href="/account?tab=favorite">Избранное</Link>
            <Link href="/account?tab=messages">Сообщения</Link>
            <Link href="/account?tab=notifications">Уведомления</Link>
            <Link href="/account/listings#new-listing">
              Разместить объявление
            </Link>
            <Link href="/account">Мой аккаунт</Link>
          </nav>
        </header>
        <div className="site-sections">
          <nav aria-label="Разделы RAUI">
            {catalogNavigation.map(({ href, label }) => (
              <Link key={label} href={href}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
        {children}
        <footer>RAUI.RU · Недвижимость</footer>
      </body>
    </html>
  );
}
