import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

test.skip(
  process.env.E2E_STAFF_TOTP !== 'true',
  'Run in the isolated staff 2FA fixture',
);
test.use({ trace: 'off' });
test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

function authenticatorCode(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = Buffer.alloc(20);
  let value = 0;
  let bits = 0;
  let offset = 0;
  for (const character of encoded) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      secret[offset++] = (value >>> bits) & 255;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  secret.fill(0);
  const index = digest.readUInt8(digest.length - 1) & 15;
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
}

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
    await target
      .getByLabel('Email', { exact: true })
      .fill(`staff-${info.project.name}@e2e.test`);
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
