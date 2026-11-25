import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

test.skip(
  process.env.E2E_EMAIL_CODE !== 'true',
  'requires the isolated email mailbox',
);
test.use({
  ignoreHTTPSErrors: true,
  trace: 'off',
  screenshot: 'off',
  video: 'off',
});
test.beforeEach(() => {
  // Independent users share the same loopback IP in the disposable browser database.
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed())
    await page.goto('about:blank');
});

async function openEmailSignIn(page: Page) {
  const origin = new URL(process.env.E2E_BASE_URL!);
  expect([origin.protocol, origin.hostname]).toEqual(['https:', '127.0.0.1']);
  const sms = await page.request.get('/api/v1/auth/phone-sign-in/capabilities');
  expect(sms.ok()).toBe(true);
  expect((await sms.json()).available).toBe(false);
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Войти в кабинет', exact: true })
    .click();
}

async function enterEmailCode(
  page: Page,
  address: string,
  options: { registerAsOwner?: boolean; existingOnly?: boolean } = {},
) {
  const email = page.getByLabel('Email', { exact: true });
  await expect(email).toBeVisible();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0);
  await email.fill(address);
  if (options.registerAsOwner) {
    await page.getByText('Роль при регистрации', { exact: true }).click();
    await page.getByLabel('Кто вы?').selectOption('owner');
  }
  const path = '/api/v1/auth/email-sign-in';
  const sent = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Получить код', exact: true }).click();
  expect((await sent).status()).toBe(201);
  const dialog = page.getByRole('dialog', { name: 'Подтверждение почты' });
  await expect(
    dialog.getByLabel('Код подтверждения', { exact: true }),
  ).toBeFocused();
  const directory = process.env.LOCAL_PRIVATE_DIR;
  if (!directory) throw new Error('Private test inbox not available');
  const mailbox = join(
    directory,
    'email-code-' + createHash('sha256').update(address).digest('hex'),
  );
  const code = await readFile(mailbox, 'utf8');
  await unlink(mailbox);
  const verification = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === path + '/confirm' &&
      r.request().method() === 'POST',
  );
  await page.keyboard.insertText(code);
  const confirmed = await verification;
  expect(confirmed.status()).toBe(201);
  expect(confirmed.request().postDataJSON().existingOnly === true).toBe(
    options.existingOnly === true,
  );
  await expect(dialog).toBeHidden();
}

for (const [prefix, heading, expectedRole] of [
  ['agent', 'Кабинет риелтора', 'agent'],
  ['code-buyer', 'Кабинет покупателя', 'buyer'],
  ['code-owner', 'Кабинет собственника', 'owner'],
] as const) {
  test(`email code opens the ${expectedRole} cabinet when SMS is unavailable`, async ({
    page,
  }, info) => {
    const address = prefix + '-' + info.project.name + '@e2e.test';
    await openEmailSignIn(page);
    await enterEmailCode(page, address, {
      registerAsOwner: prefix === 'code-owner',
    });
    const cabinet = page.getByRole('heading', { name: heading, level: 1 });
    await expect(cabinet).toBeFocused();
    const session = await page.request.get('/api/v1/auth/me');
    expect(session.status()).toBe(200);
    const user = await session.json();
    expect(user.email === address).toBe(true);
    expect(user.role).toBe(expectedRole);
    expect(typeof user.email_verified_at).toBe('string');
    expect(user.registration_approval_state).toBe(
      prefix === 'agent' ? 'approved' : 'pending',
    );
    if (prefix !== 'agent') expect(user.phone_verified_at).toBeNull();
  });
}

test('forgotten password opens the existing agent cabinet with email code and preserves password login', async ({
  page,
}, info) => {
  const address = 'code-recovery-' + info.project.name + '@e2e.test';
  const cabinet = page.getByRole('heading', {
    name: 'Кабинет риелтора',
    level: 1,
  });
  async function passwordSignIn() {
    await page
      .getByRole('button', { name: 'Другой способ', exact: true })
      .click();
    await page.getByLabel('Email', { exact: true }).fill(address);
    await page
      .getByLabel('Пароль', { exact: true })
      .fill('E2E-only-password-42!');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(cabinet).toBeVisible();
    const response = await page.request.get('/api/v1/auth/me');
    expect(response.status()).toBe(200);
    const user = await response.json();
    expect(user.role).toBe('agent');
    expect(typeof user.id).toBe('string');
    expect(user.public_id).toMatch(/^[1-9][0-9]*$/);
    return { id: user.id as string, publicId: user.public_id as string };
  }
  async function signOut() {
    const loggedOut = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/v1/auth/logout' &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    expect((await loggedOut).ok()).toBe(true);
    await expect(cabinet).toBeHidden();
  }
  await openEmailSignIn(page);
  const original = await passwordSignIn();
  await signOut();
  await openEmailSignIn(page);
  await page
    .getByRole('button', { name: 'Другой способ', exact: true })
    .click();
  await page.getByRole('link', { name: 'Забыли пароль?', exact: true }).click();
  await expect(page).toHaveURL(/\/account\?action=recover$/);
  await enterEmailCode(page, address, { existingOnly: true });
  await expect(cabinet).toBeFocused();
  await page.reload();
  await expect(cabinet).toBeVisible();
  const recovered = await page.request.get('/api/v1/auth/me');
  expect(recovered.status()).toBe(200);
  expect(await recovered.json()).toMatchObject({
    id: original.id,
    public_id: original.publicId,
    role: 'agent',
  });
  await expect(
    page.getByText('ID: ' + original.publicId, { exact: true }),
  ).toBeVisible();
  await signOut();
  await openEmailSignIn(page);
  expect(await passwordSignIn()).toEqual(original);
});
