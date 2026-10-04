import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});
async function login(page: Page) {
  await page.goto('/account');
  await page.getByLabel('Email', { exact: true }).fill('buyer@e2e.test');
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Мой аккаунт' }),
  ).toBeVisible();
  await expect(
    page.getByText('Тестовый пользователь', { exact: true }),
  ).toBeVisible();
}
test('search → filter → detail → favorite and comparison', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await page.getByLabel('Цена до', { exact: true }).fill('15000000');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Описание', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'В избранное', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Добавлено в избранное');
  await page.getByRole('button', { name: 'Сравнить', exact: true }).click();
  await page
    .getByRole('link', { name: 'Открыть аккаунт', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Квартира 2 комнаты', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Сравнение', exact: true }).click();
  await expect(
    page.getByRole('table', { name: 'Сравнение объектов' }),
  ).toBeVisible();
});
test('map/list viewport synchronization and keyboard markers', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Карта', exact: true }).click();
  await expect(page.locator('.leaflet-map')).toBeVisible();
  await expect(page.locator('.price-marker').first()).toBeVisible();
  await expect
    .poll(async () =>
      page
        .locator('.price-marker span')
        .evaluateAll((nodes) =>
          nodes.reduce(
            (sum, node) => sum + Number(node.getAttribute('data-count')),
            0,
          ),
        ),
    )
    .toBe(2);
  await expect(page.locator('.price-marker').first()).toHaveAttribute(
    'tabindex',
    '0',
  );
  await page.screenshot({
    path: '../../.cache/map-' + test.info().project.name + '.png',
  });
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Квартира 2 комнаты', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Квартира 3 комнаты', exact: true }),
  ).toBeVisible();
});
test('saved search CRUD and reopening filters', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await page.getByLabel('Цена до', { exact: true }).fill('15000000');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page
    .getByRole('button', { name: 'Сохранить поиск', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Поиск сохранён' }),
  ).toBeVisible();
  await page.goto('/account');
  await page
    .getByRole('button', { name: 'Сохранённые поиски', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Открыть поиск', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
});
test('inquiry and account messages', async ({ page }, testInfo) => {
  const text = 'Можно посмотреть квартиру? ' + testInfo.project.name;
  await login(page);
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
    .click();
  await page.getByLabel('Сообщение продавцу', { exact: true }).fill(text);
  await page
    .getByRole('button', { name: 'Отправить сообщение', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Сообщение отправлено');
  await page.goto('/account');
  await page.getByRole('button', { name: 'Сообщения', exact: true }).click();
  await page
    .getByRole('button', { name: 'Открыть переписку', exact: true })
    .click();
  await expect(page.getByText(text, { exact: false })).toBeVisible();
});
test('accessibility and responsive search baseline', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'К содержимому' })).toBeFocused();
});

test('listing SEO metadata and unavailable pages are safe', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
    .click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new RegExp('/listings/'),
  );
  const structured = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ??
      '{}',
  );
  expect(structured['@type']).toBe('RealEstateListing');
  const response = await page.goto(
    '/listings/00000000-0000-4000-8000-000000000000',
  );
  expect(response?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
    'content',
    /noindex/,
  );
});
