import { headers } from 'next/headers';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import './site-header.css';
import Link from 'next/link';
import BrandLogo from '../components/brand-logo';
import { AccountEntryLink } from '../components/account-entry-link';
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
          <nav aria-label="Основная навигация">
            {/* Use native fragment navigation when returning from the homepage map. */}
            <a
              className="site-header-brand"
              href="/#page-top"
              aria-label="RAUI.RU — главная"
            >
              <BrandLogo />
            </a>
            <AccountEntryLink href="/account" className="site-header-login">
              Войти в кабинет
            </AccountEntryLink>
            <AccountEntryLink
              href="/account/listings#new-listing"
              intent="publish"
              className="site-header-publish"
            >
              Разместить объявление
            </AccountEntryLink>
            <div className="site-header-links">
              <Link href="/search">Недвижимость</Link>
              <AccountEntryLink href="/account?tab=favorite">
                Избранное
              </AccountEntryLink>
              <AccountEntryLink href="/account?tab=messages">
                Сообщения
              </AccountEntryLink>
              <AccountEntryLink href="/account?tab=notifications">
                Уведомления
              </AccountEntryLink>
            </div>
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
        <footer>
          <Link href="/support">Служба поддержки</Link>
        </footer>
      </body>
    </html>
  );
}
