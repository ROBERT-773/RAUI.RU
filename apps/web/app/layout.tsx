import { headers } from 'next/headers';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = {
  title: 'RAUI.RU',
  description: 'Портал недвижимости',
};
export default async function Layout({ children }: { children: ReactNode }) {
  await headers(); // Request-scoped rendering lets Next apply the CSP nonce to hydration scripts.
  return (
    <html lang="ru">
      <body>
        <a className="skip" href="#content">
          К содержимому
        </a>
        <header>
          <Link href="/" aria-label="RAUI.RU — главная">
            RAUI.RU
          </Link>
          <nav aria-label="Основная навигация">
            <Link href="/search">Недвижимость</Link>
            <Link href="/account">Мой аккаунт</Link>
          </nav>
        </header>
        {children}
        <footer>RAUI.RU · Недвижимость</footer>
      </body>
    </html>
  );
}
