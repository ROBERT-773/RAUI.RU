import { expect, test, type Page } from '@playwright/test';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

test.skip(process.env.E2E_SMS !== 'true', 'requires the isolated SMS fixture');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed())
    await page.goto('about:blank');
});

async function enterDeliveredCode(page: Page, phone: string, paste = false) {
  const capabilities = await page.request.get(
    '/api/v1/auth/phone-sign-in/capabilities',
  );
  expect(capabilities.status()).toBe(200);
  expect(await capabilities.json()).toEqual({ available: true });
  await page.goto('/');
  const entry = page.getByRole('link', {
    name: 'Войти в кабинет',
    exact: true,
  });
  await expect(entry).toBeVisible();
  await entry.click();
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
  const dialog = page.getByRole('dialog', { name: 'Подтверждение телефона' });
  const field = dialog.getByLabel('Код подтверждения', { exact: true });
  await expect(field).toBeFocused();
  await expect(
    dialog.getByRole('timer', { name: 'До повторной отправки' }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Отправить новый код' }),
  ).toBeDisabled();
  expect((await field.inputValue()).length).toBe(0);
  const project = test.info().project.name;
  if (!paste && ['chromium', 'ios-webkit'].includes(project))
    await page.screenshot({
      path: '../../.cache/phone-sign-in-waiting-' + project + '.png',
      animations: 'disabled',
      scale: 'css',
    });
  const mailbox = resolve(directory, 'sms-' + challengeId);
  const code = await readFile(mailbox, 'utf8');
  await unlink(mailbox);
  const confirmPath = '/api/v1/auth/phone-sign-in/confirm';
  let confirmations = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === confirmPath
    )
      confirmations++;
  });
  if (!paste) {
    await page.keyboard.insertText(code.slice(0, 5));
    await expect(dialog).toBeVisible();
    expect((await field.inputValue()).length).toBe(5);
    expect(confirmations).toBe(0);
  }
  const confirmed = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === confirmPath,
  );
  await page.keyboard.insertText(paste ? code : code.slice(5));
  expect((await confirmed).status()).toBe(201);
  await expect(dialog).toBeHidden();
  return () => expect(confirmations).toBe(1);
}

test('verified phone signs in to the existing cabinet', async ({
  page,
}, info) => {
  const assertConfirmedOnce = await enterDeliveredCode(
    page,
    '+700000000' + String(info.project.name.length).padStart(2, '0'),
  );
  const cabinet = page.getByRole('heading', {
    name: 'Кабинет риелтора',
    level: 1,
  });
  await expect(cabinet).toBeVisible();
  await expect(cabinet).toBeFocused();
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    email: `agent-${info.project.name}@e2e.test`,
  });
  assertConfirmedOnce();
});

test('new phone opens profile setup without granting publication approval', async ({
  page,
}, info) => {
  const assertConfirmedOnce = await enterDeliveredCode(
    page,
    '+700000000' + String(20 + info.project.name.length),
    true,
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
  const cabinet = page.getByRole('heading', {
    name: 'Кабинет собственника',
    level: 1,
  });
  await expect(cabinet).toBeVisible();
  await expect(cabinet).toBeFocused();
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    registration_approval_state: 'pending',
    phone_verified_at: expect.any(String),
    email_verified_at: null,
  });
  assertConfirmedOnce();
});
