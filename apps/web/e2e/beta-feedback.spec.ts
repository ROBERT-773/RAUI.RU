import { continueWithIdentifier } from './sign-in';
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const formName = 'Обратная связь о портале';
const question = 'Что бы вы хотели видеть на портале?';
const adminTitle = 'Предложения о портале';
const feedbackPath = '/api/v1/account/feedback';
const inboxPath = '/api/v1/admin/feedback';

test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

async function signIn(page: Page, email: string) {
  await continueWithIdentifier(page, email);
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

test('a guest can dismiss the beta invitation and return to feedback after a reload', async ({
  page,
}) => {
  await page.goto('/');
  const banner = page.getByRole('region', {
    name: 'Бесплатное размещение объявлений',
  });
  const publish = banner.getByRole('link', { name: 'Разместить объявление' });
  await expect(banner).toContainText(/бесплатн/i);
  await expect(publish).toHaveAttribute(
    'href',
    '/account/listings#new-listing',
  );
  await publish.click();
  const prompt = page.getByRole('dialog', {
    name: 'Войдите, чтобы разместить объявление',
    exact: true,
  });
  await expect(prompt).toBeVisible();
  await expect(page).toHaveURL('/');
  await prompt.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(publish).toBeFocused();

  await banner.getByRole('button', { name: 'Закрыть приглашение' }).click();
  await expect(publish).toBeHidden();
  await page.reload();
  const feedback = page.getByRole('button', { name: 'Оставить отзыв' });
  await feedback.click();
  await expect(publish).toBeHidden();
  await expect(banner.getByRole('heading')).toHaveCount(0);
  const form = page.getByRole('form', { name: formName });
  await expect(form.getByRole('textbox', { name: question })).toBeVisible();
  await expect(
    form.getByRole('link', { name: 'Войти и продолжить' }),
  ).toHaveAttribute('href', '/account?action=feedback');
  await page
    .getByRole('dialog', { name: formName })
    .getByRole('button', { name: 'Закрыть форму' })
    .click();
  await expect(form).toBeHidden();
  await expect(feedback).toBeFocused();
});

test('a proposal survives login and is visible only to the administrator', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const proposal = `Показывайте планировку рядом с фотографиями. ${randomUUID()}`;
  await page.goto('/');
  const guestInbox = await page.request.get(inboxPath);
  expect(guestInbox.status()).toBe(401);
  const guestPost = await page.request.post(feedbackPath, {
    headers: { Origin: new URL(page.url()).origin },
    data: { message: proposal, requestId: randomUUID() },
  });
  expect(guestPost.status()).toBe(401);

  await page.getByRole('button', { name: 'Оставить отзыв' }).click();
  const form = page.getByRole('form', { name: formName });
  const field = form.getByRole('textbox', { name: question });
  await field.fill(proposal);
  await form.getByRole('link', { name: 'Войти и продолжить' }).click();
  await expect(page).toHaveURL(/\/account\?action=feedback$/);
  await signIn(page, 'buyer@e2e.test');
  await expect(field).toHaveValue(proposal);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === feedbackPath,
  );
  await form.getByRole('button', { name: 'Отправить предложение' }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({
    message: proposal,
    requestId: expect.stringMatching(/^[a-f\d-]{36}$/i),
  });
  await expect(
    page.getByText('Спасибо! Ваше предложение отправлено.', {
      exact: true,
    }),
  ).toBeVisible();

  const buyerInbox = await page.request.get(inboxPath);
  expect(buyerInbox.status()).toBe(403);
  expect(await buyerInbox.text()).not.toContain(proposal);
  await page.goto('/admin/feedback');
  await expect(page.getByText(proposal, { exact: true })).toHaveCount(0);

  const adminContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    await admin.goto('/account');
    await signIn(admin, 'admin@e2e.test');
    await admin.getByRole('link', { name: adminTitle, exact: true }).click();
    await expect(admin).toHaveURL(/\/admin\/feedback$/);
    await expect(
      admin.getByRole('heading', { name: adminTitle }),
    ).toBeVisible();
    await expect(admin.getByText(proposal, { exact: true })).toBeVisible();
    await admin.reload();
    await expect(admin.getByText(proposal, { exact: true })).toBeVisible();
  } finally {
    await adminContext.close();
  }
});

test('the beta publication link returns a guest owner to the manual listing form after sign-in', async ({
  page,
}, info) => {
  await page.goto('/');
  await page
    .getByRole('region', { name: 'Бесплатное размещение объявлений' })
    .getByRole('link', { name: 'Разместить объявление', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', {
      name: 'Войдите, чтобы разместить объявление',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL('/');

  await signIn(page, `quota-${info.project.name}@e2e.test`);
  await expect(page).toHaveURL(/\/account\/listings#new-listing$/);
  const form = page.locator('form#new-listing');
  await expect(
    form.getByRole('heading', { name: 'Новое объявление', exact: true }),
  ).toBeVisible();
  await expect(
    form.getByRole('button', { name: 'Сохранить в черновики', exact: true }),
  ).toBeEnabled();
});
