import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test.skip(process.env.E2E_SMS !== 'true', 'requires the isolated SMS fixture');

async function enterDeliveredCode(page: Page, phone: string) {
  const capabilities = await page.request.get(
    '/api/v1/auth/phone-sign-in/capabilities',
  );
  expect(capabilities.status()).toBe(200);
  expect(await capabilities.json()).toEqual({ available: true });
  await page.goto('/account');
  await expect(
    page.getByRole('heading', { name: 'Вход или регистрация' }),
  ).toBeVisible();
  await page.getByLabel('Мобильный телефон').fill(phone);
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/phone-sign-in') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Получить код' }).click();
  const response = await sent;
  expect(response.status()).toBe(201);
  const { challengeId, delivery } = (await response.json()) as {
    challengeId: string;
    delivery: string;
  };
  expect(delivery).toBe('accepted');
  expect(challengeId).toMatch(/^[0-9a-f-]{36}$/);
  const directory = process.env.LOCAL_PRIVATE_DIR;
  if (!directory) throw new Error('SMS fixture mailbox unavailable');
  const code = await readFile(resolve(directory, 'sms-' + challengeId), 'utf8');
  await page.getByLabel('Код из SMS').fill(code);
  await page.getByRole('button', { name: 'Подтвердить код' }).click();
}

test('verified phone signs in to the existing cabinet', async ({
  page,
}, info) => {
  await enterDeliveredCode(
    page,
    '+700000000' + String(info.project.name.length).padStart(2, '0'),
  );
  await expect(
    page.getByRole('heading', { name: 'Кабинет риелтора' }),
  ).toBeVisible();
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    email: `agent-${info.project.name}@e2e.test`,
  });
});

test('new phone opens profile setup without granting publication approval', async ({
  page,
}, info) => {
  await enterDeliveredCode(
    page,
    '+700000000' + String(20 + info.project.name.length),
  );
  await page.getByLabel('Кто вы?').selectOption('owner');
  await page.getByLabel('Имя', { exact: true }).fill('Тестовый собственник');
  await page
    .getByLabel('Email', { exact: true })
    .fill(`sms-owner-${info.project.name}@e2e.test`);
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(
    page.getByRole('heading', { name: 'Кабинет собственника' }),
  ).toBeVisible();
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    registration_approval_state: 'pending',
    phone_verified_at: expect.any(String),
    email_verified_at: null,
  });
});
