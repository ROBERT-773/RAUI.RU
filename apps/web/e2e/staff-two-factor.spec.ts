import { continueWithIdentifier } from './sign-in';
import { execFileSync } from 'node:child_process';
import { authenticatorCode } from './authenticator-code';
import { expect, test, type Page } from '@playwright/test';

test.skip(
  process.env.E2E_STAFF_TOTP !== 'true',
  'Run in the isolated staff 2FA fixture',
);
test.use({ trace: 'off' });
test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

test('staff enrolls in the browser and a separate session remains locked', async ({
  page,
  browser,
}, info) => {
  const password = 'E2E-only-password-42!';
  async function submit(
    target: Page,
    name: string,
    path: string,
    status: number,
  ) {
    const [response] = await Promise.all([
      target.waitForResponse(
        (value) =>
          value.request().method() === 'POST' &&
          new URL(value.url()).pathname === '/api/v1/' + path,
      ),
      target.getByRole('button', { name, exact: true }).click(),
    ]);
    expect(response.status(), path).toBe(status);
  }
  async function login(target: Page) {
    await target.goto('/account');
    await continueWithIdentifier(target, `staff-${info.project.name}@e2e.test`);
    await target.getByLabel('Пароль', { exact: true }).fill(password);
    await submit(target, 'Войти', 'auth/login', 201);
    await expect(
      target.getByRole('heading', { name: 'Мой аккаунт', exact: true }),
    ).toBeVisible();
  }
  await login(page);
  expect((await page.request.get('/api/v1/admin/moderation')).status()).toBe(
    403,
  );
  await page.goto('/admin/moderation');
  await page.getByLabel('Пароль аккаунта').fill(password);
  await submit(page, 'Настроить второй фактор', 'auth/staff-totp/enroll', 201);
  const key = page.locator('main code');
  await expect(key).toBeVisible();
  const secret = await key.innerText();
  await page.getByLabel('Код из приложения').fill(authenticatorCode(secret));
  await submit(page, 'Подтвердить вход', 'auth/staff-totp/activate', 204);
  await expect(
    page.getByRole('heading', { name: 'Проверка входа сотрудника' }),
  ).toHaveCount(0);
  expect((await page.request.get('/api/v1/admin/moderation')).status()).toBe(
    200,
  );
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    await login(other);
    await other.goto('/admin/moderation');
    await expect(other.getByLabel('Код из приложения')).toBeVisible();
    await expect(other.getByLabel('Пароль аккаунта')).toHaveCount(0);
    expect((await other.request.get('/api/v1/admin/moderation')).status()).toBe(
      403,
    );
  } finally {
    await second.close();
  }
});
