import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import SupportPage from './page';

afterEach(cleanup);

test('shows the public questions and real recovery and publication links', async () => {
  render(await SupportPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByLabelText('Поиск по справке')).toBeTruthy();
  expect(screen.getByText('Не приходит код')).toBeTruthy();
  expect(screen.getByText('Как правильно указать адрес?')).toBeTruthy();
  expect(screen.getByText('Восстановить доступ').getAttribute('href')).toBe(
    '/account/forgot-password',
  );
  expect(screen.getByText('Разместить объявление').getAttribute('href')).toBe(
    '/account/listings#new-listing',
  );
  expect(screen.getByText('Все вопросы').getAttribute('href')).toBe(
    '/support?all=1',
  );
});

test('searches the complete help collection including questions outside the frequent list', async () => {
  render(
    await SupportPage({
      searchParams: Promise.resolve({ q: '  КОНТАКТЫ изменить ' }),
    }),
  );
  expect(screen.getByText('Как изменить контакты в объявлениях?')).toBeTruthy();
  expect(screen.queryByText('Не приходит код')).toBeNull();
  expect(screen.getByText('Настроить контакты').getAttribute('href')).toBe(
    '/account?section=contacts#contact-settings',
  );
});

test('offers the full question list when no article matches', async () => {
  render(
    await SupportPage({
      searchParams: Promise.resolve({ q: 'несуществующийраздел' }),
    }),
  );
  expect(screen.getByText(/ничего не найдено/)).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Все вопросы' }).getAttribute('href'),
  ).toBe('/support?all=1');
});

test('a blocked account can find the moderation form without signing in', async () => {
  render(
    await SupportPage({
      searchParams: Promise.resolve({ q: 'аккаунт заблокирован' }),
    }),
  );
  expect(screen.getByText(/Открыть обращение можно без входа/)).toBeTruthy();
  const link = screen.getByText('Обратиться по поводу модерации');
  expect(link.getAttribute('href')).toBe('/support?write=1&topic=moderation');
});
