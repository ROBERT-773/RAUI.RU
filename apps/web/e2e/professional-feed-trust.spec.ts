import { continueWithIdentifier } from './sign-in';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { authenticatorCode } from './authenticator-code';

test.skip(
  process.env.E2E_TRUSTED_FEEDS !== 'true',
  'Requires the isolated, TOTP-protected XML fixture',
);
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const password = 'E2E-only-password-42!';
const adminPath = '/api/v1/admin/integrations/feeds';
async function login(page: Page, email: string, heading: string) {
  await page.goto('/account');
  await continueWithIdentifier(page, email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: heading, exact: true }),
  ).toBeVisible();
}
type Source = { id: string; trusted: boolean; lastApplyRunId: string | null };
type Item = { external_reference: string; listing_id: string | null };
async function appliedRun(page: Page, base: string, previous: string | null) {
  let runId = '';
  let feedId = '';
  await expect
    .poll(
      async () => {
        const response = await page.request.get(base + '/links');
        expect(response.ok()).toBeTruthy();
        const [source] = (await response.json()) as Source[];
        if (
          !source?.trusted ||
          !source.lastApplyRunId ||
          source.lastApplyRunId === previous
        )
          return null;
        runId = source.lastApplyRunId;
        feedId = source.id;
        const report = await page.request.get(
          base + '/' + feedId + '/runs/' + runId,
        );
        return (await report.json()).status;
      },
      { timeout: 45000 },
    )
    .toBe('quarantined');
  return { feedId, runId };
}
async function imported(page: Page, base: string, previous: string | null) {
  const { feedId, runId } = await appliedRun(page, base, previous);
  const details = await page.request.get(
    base + '/' + feedId + '/runs/' + runId + '/items',
  );
  const items = (await details.json()) as Item[];
  const listing = items.find(
    (item) => item.external_reference === 'available-flat',
  );
  expect(listing?.listing_id).toBeTruthy();
  await page
    .getByRole('region', { name: 'ЦИАН', exact: true })
    .getByRole('button', { name: 'Обновить отчёты' })
    .click();
  const group = page.getByRole('group', { name: 'Последний импорт' });
  await expect(group.getByRole('status')).toHaveText(
    previous
      ? 'Получено — 2. Добавлено — 0. Обновлено — 1. Без изменений — 0. С ошибками — 1.'
      : 'Получено — 2. Добавлено — 1. Обновлено — 0. Без изменений — 0. С ошибками — 1.',
  );
  return { runId, listingId: listing!.listing_id!, feedId };
}
test('an administrator approves a checked XML source with TOTP, its owner sees a published photo, scheduled price update and revoked approval', async ({
  browser,
  page,
}, info) => {
  test.setTimeout(160000);
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
  const key = randomUUID(),
    ownerName = 'XML ' + key;
  await login(
    page,
    `feed-owner-${info.project.name}@e2e.test`,
    'Кабинет агентства',
  );
  await page.getByLabel('Название агентства').fill(ownerName);
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/organizations',
  );
  await page
    .getByRole('button', { name: 'Создать агентство', exact: true })
    .click();
  const org = await created;
  expect(org.status()).toBe(201);
  const base = '/api/v1/organizations/' + (await org.json()).id + '/feeds';
  await page.getByText('XML-выгрузки организации', { exact: true }).click();
  const source = page.getByRole('region', { name: 'ЦИАН', exact: true });
  await source
    .getByRole('textbox')
    .fill('https://xml-fixture.example.test/trusted-' + key + '.xml');
  await source.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(source.getByRole('status')).toHaveText(
    'Проверено объектов — 2. Прошли проверку — 1. С ошибками — 1.',
    { timeout: 25000 },
  );
  const preview = await page.request.get(base + '/links');
  expect(await preview.json()).toEqual([
    expect.objectContaining({ trusted: false, lastApplyRunId: null }),
  ]);
  await expect(
    page.getByRole('group', { name: 'Последний импорт' }),
  ).toHaveCount(0);
  expect((await page.request.get(adminPath)).status()).toBe(403);
  const staff = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const admin = await staff.newPage();
    await login(
      admin,
      `feed-admin-${info.project.name}@e2e.test`,
      'Мой аккаунт',
    );
    expect((await admin.request.get(adminPath)).status()).toBe(403);
    await admin.getByRole('link', { name: 'Автопубликация из XML' }).click();
    await admin.getByLabel('Пароль аккаунта').fill(password);
    await admin
      .getByRole('button', { name: 'Настроить второй фактор' })
      .click();
    const secret = await admin.locator('main code').innerText();
    await admin.getByLabel('Код из приложения').fill(authenticatorCode(secret));
    await admin.getByRole('button', { name: 'Подтвердить вход' }).click();
    const row = admin.getByRole('region', {
      name: ownerName + ' · ЦИАН',
      exact: true,
    });
    await row.getByRole('button', { name: 'Разрешить автопубликацию' }).click();
    await expect(
      row.getByRole('button', { name: 'Отозвать разрешение' }),
    ).toBeVisible();
    const first = await imported(page, base, null);
    const publicPath = '/api/v1/listings/' + first.listingId + '/public';
    const visitor = await browser.newPage({
      baseURL: new URL(page.url()).origin,
    });
    try {
      const publicListing = await visitor.request.get(publicPath);
      expect(publicListing.status()).toBe(200);
      const listing = await publicListing.json();
      expect(Number(listing.price)).toBe(9500000);
      expect(listing.media).toHaveLength(1);
      const photo = await visitor.request.get(
        '/api/v1/media/' + listing.media[0].id + '/small',
      );
      expect(photo.status()).toBe(200);
      expect(photo.headers()['content-type']).toMatch(/^image\//);
      expect(
        (await visitor.goto('/listings/' + first.listingId))?.status(),
      ).toBe(200);
      await expect(
        visitor.getByRole('heading', { name: listing.title, exact: true }),
      ).toBeVisible();
      const visiblePhoto = visitor
        .getByRole('region', { name: 'Фотографии', exact: true })
        .getByRole('img', { name: 'Фото недвижимости', exact: true });
      await visiblePhoto.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          visiblePhoto.evaluate(
            (image: HTMLImageElement) => image.naturalWidth,
          ),
        )
        .toBeGreaterThan(0);
      execFileSync(process.execPath, [
        '../api/scripts/e2e-advance-feed.mjs',
        first.feedId,
        key,
        'price-updated',
      ]);
      const next = await imported(page, base, first.runId);
      expect(next.listingId).toBe(first.listingId);
      expect(
        Number((await (await visitor.request.get(publicPath)).json()).price),
      ).toBe(9750000);
      execFileSync(process.execPath, [
        '../api/scripts/e2e-advance-feed.mjs',
        first.feedId,
        key,
        'invalid-photo',
      ]);
      await appliedRun(page, base, next.runId);
      await source.getByRole('button', { name: 'Обновить отчёты' }).click();
      const rejected = page.getByRole('group', { name: 'Последний импорт' });
      await expect(rejected.getByRole('status')).toHaveText(
        'Получено — 2. Добавлено — 0. Обновлено — 0. Без изменений — 0. С ошибками — 2.',
      );
      await rejected.getByRole('button', { name: 'Посмотреть ошибки' }).click();
      await expect(
        rejected.getByRole('listitem').filter({ hasText: 'available-flat' }),
      ).toContainText(/изображения|фотограф/i);
      const retained = await visitor.request.get(publicPath);
      expect(retained.status()).toBe(200);
      const retainedListing = await retained.json();
      expect(Number(retainedListing.price)).toBe(9750000);
      expect(retainedListing.media).toEqual(listing.media);
    } finally {
      await visitor.close();
    }
    await row.getByRole('button', { name: 'Отозвать разрешение' }).click();
    await expect(
      row.getByRole('button', { name: 'Отозвать разрешение' }),
    ).toHaveCount(0);
    await source.getByRole('button', { name: 'Обновить отчёты' }).click();
    await expect(source.getByText(/Без автопубликации/)).toBeVisible();
  } finally {
    await staff.close();
  }
});
