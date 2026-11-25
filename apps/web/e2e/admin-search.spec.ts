import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const title = 'Поиск пользователей и объявлений';
// The product E2E fixture seeds these synthetic contact numbers on quota owners.
const phone = '+70000001001';
const nationalPhone = '8 (000) 000-10-01';
const address = 'Москва, Тверская';
const apartment = 'Квартира 2 комнаты';
const adminPath = '/admin/search';
const apiPath = '/api/v1' + adminPath;

test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

async function signIn(page: Page, email: string) {
  await page.goto('/account');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

async function submit(page: Page, mode: 'users' | 'listings', query: string) {
  const label = mode === 'users' ? 'Поиск пользователей' : 'Поиск объявлений';
  await page.getByRole('textbox', { name: label, exact: true }).fill(query);
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === apiPath + '/' + mode &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).search).toBe('');
  expect(response.request().postDataJSON()).toEqual({ query });
  expect(new URL(page.url()).search).toBe('');
  return response;
}

test('administrator finds the same account by phone and public ID and opens a published address match', async ({
  page,
}) => {
  test.setTimeout(60000);
  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));
  await signIn(page, 'admin@e2e.test');
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/search$/);
  await expect(
    page.getByRole('heading', { name: title, level: 1 }),
  ).toBeVisible();
  const results = page.getByRole('region', { name: 'Результаты поиска' });
  await submit(page, 'users', 'absent-user@not-found.e2e.test');
  await expect(results.getByText(/^Пользователи не найдены\./)).toBeVisible();
  await expect(results.getByRole('listitem')).toHaveCount(0);
  const first = await submit(page, 'users', nationalPhone);
  const users = (await first.json()).items;
  expect(users).toHaveLength(1);
  const user = users[0] as {
    publicId: string;
    email: string;
    matchedPhone: string;
  };
  expect(user.matchedPhone).toBe(phone);
  expect(user.email).toMatch(/^quota-[\w-]+@e2e\.test$/);
  expect(user.publicId).toMatch(/^\d+$/);
  const userRow = results.getByRole('listitem').filter({ hasText: user.email });
  await expect(userRow).toContainText(user.publicId);
  await expect(userRow.getByText(phone, { exact: true })).toBeVisible();
  await page.screenshot({
    path:
      '../../.cache/admin-search-users-' + test.info().project.name + '.png',
    animations: 'disabled',
    scale: 'css',
  });
  for (const query of [phone, user.publicId]) {
    const found = await submit(page, 'users', query);
    expect((await found.json()).items).toEqual([
      expect.objectContaining({
        publicId: user.publicId,
        email: user.email,
        matchedPhone: query === phone ? phone : null,
      }),
    ]);
    await expect(userRow).toBeVisible();
  }
  const sellerSearch = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === apiPath + '/listings' &&
      r.request().method() === 'POST',
  );
  await userRow
    .getByRole('button', { name: 'Объявления пользователя' })
    .click();
  const sellerResponse = await sellerSearch;
  expect(sellerResponse.ok()).toBe(true);
  expect(sellerResponse.request().postDataJSON()).toEqual({
    query: user.publicId,
    by: 'seller',
  });
  const sellerPage = (await sellerResponse.json()) as {
    items: { sellerPublicId: string }[];
  };
  expect(
    sellerPage.items.every((item) => item.sellerPublicId === user.publicId),
  ).toBe(true);
  await expect(
    page.getByRole('heading', {
      name: 'Объявления пользователя №' + user.publicId,
    }),
  ).toBeVisible();
  await expect(results.locator('tbody tr')).toHaveCount(
    sellerPage.items.length,
  );
  await page
    .getByRole('button', { name: 'Искать другие объявления', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Поиск объявлений' }),
  ).toHaveValue('');
  await expect(userRow).toHaveCount(0);
  await submit(page, 'listings', 'Несуществующая улица E2E');
  await expect(results.getByText(/^Объявления не найдены\./)).toBeVisible();
  const matches = await submit(page, 'listings', address);
  const items = (await matches.json()).items as {
    id: string;
    title: string;
    publiclyVisible: boolean;
  }[];
  const match = items.find((item) => item.title === apartment);
  expect(match?.publiclyVisible).toBe(true);
  const row = results.getByRole('row').filter({
    has: page.getByRole('heading', { name: apartment, exact: true }),
  });
  await expect(row).toContainText(address);
  await expect(userRow).toHaveCount(0);
  await page.screenshot({
    path:
      '../../.cache/admin-search-listings-' + test.info().project.name + '.png',
    animations: 'disabled',
    scale: 'css',
  });
  const listing = await submit(page, 'listings', match!.id);
  expect((await listing.json()).items).toEqual([
    expect.objectContaining({ id: match!.id, title: apartment }),
  ]);
  const link = row.getByRole('link', { name: 'Открыть объявление' });
  await expect(link).toHaveAttribute('href', '/listings/' + match!.id);
  await link.click();
  await expect(page).toHaveURL(new RegExp('/listings/' + match!.id + '$'));
  await expect(
    page.getByRole('heading', { name: apartment, level: 1 }),
  ).toBeVisible();
  for (const url of requestUrls) {
    for (const value of new URL(url).searchParams.values()) {
      expect(value.replace(/\D/g, '')).not.toMatch(/[78]0000001001/);
    }
  }
});

test('a buyer cannot read either administrative search', async ({ page }) => {
  await signIn(page, 'buyer@e2e.test');
  await expect(
    page.getByRole('heading', { name: 'Кабинет покупателя' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: title, exact: true }),
  ).toHaveCount(0);
  const csrf = await page.request.get('/api/v1/auth/csrf');
  expect(csrf.status()).toBe(200);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  for (const [mode, query] of [
    ['users', phone],
    ['listings', address],
  ]) {
    const response = await page.request.post(apiPath + '/' + mode, {
      headers: {
        Origin: new URL(page.url()).origin,
        'X-CSRF-Token': csrfToken,
      },
      data: { query },
    });
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain('items');
  }
  await page.goto(adminPath);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'доступ',
  );
  await expect(
    page.getByRole('button', { name: 'Найти', exact: true }),
  ).toHaveCount(0);
});
