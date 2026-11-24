import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

async function login(page: Page, email: string, heading: string) {
  await page.goto('/account');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: heading, exact: true }),
  ).toBeVisible();
}
async function checkFeed(page: Page, summary: string, base: string) {
  await page.getByText(summary, { exact: true }).click();
  for (const name of ['Яндекс Недвижимость', 'Авито', 'ЦИАН', 'Домклик']) {
    await expect(
      page.getByRole('textbox', { name, exact: true }),
    ).toBeVisible();
  }
  const row = page.getByRole('region', { name: 'ЦИАН', exact: true });
  const input = row.getByRole('textbox', { name: 'ЦИАН' });
  await input.fill('https://xml-fixture.example.test/cian.xml');
  const sent = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === base + '/link' &&
      res.request().method() === 'POST',
  );
  await row.getByRole('button', { name: 'Проверить', exact: true }).click();
  const queued = await sent;
  expect(queued.status()).toBe(201);
  const { feed, preview } = (await queued.json()) as {
    feed: { id: string };
    preview: { runId: string };
  };
  const summaryText =
    'Проверено объектов — 2. Прошли проверку — 1. С ошибками — 1.';
  await expect(row.getByRole('status')).toHaveText(summaryText, {
    timeout: 25000,
  });
  await expect(input).toHaveValue('');
  await row.getByRole('button', { name: 'Посмотреть ошибки' }).click();
  await expect(row.getByRole('listitem')).toContainText(/цену/i);
  const reportUrl = base + '/' + feed.id + '/runs/' + preview.runId;
  const report = await page.request.get(reportUrl);
  expect(report.status()).toBe(200);
  expect(await report.json()).toMatchObject({
    id: preview.runId,
    status: 'quarantined',
    stats: { total: 2, valid: 1, quarantined: 1 },
  });
  await page.reload();
  await page.getByText(summary, { exact: true }).click();
  await expect(row.getByRole('status')).toHaveText(summaryText);
  await expect(input).toHaveValue('');
  return reportUrl;
}
test('the personal agent and agency owner check a feed, reopen its row errors and cannot see another account’s report', async ({
  browser,
  page,
}, info) => {
  test.setTimeout(100000);
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
  await login(page, `agent-${info.project.name}@e2e.test`, 'Кабинет риелтора');
  const privateReport = await checkFeed(
    page,
    'Мои XML-выгрузки',
    '/api/v1/account/feeds',
  );
  const agency = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const manager = await agency.newPage();
    await login(
      manager,
      `agency-${info.project.name}@e2e.test`,
      'Кабинет агентства',
    );
    expect([403, 404]).toContain(
      (await manager.request.get(privateReport)).status(),
    );
    await manager.getByLabel('Название агентства').fill('XML ' + randomUUID());
    const created = manager.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/v1/organizations' &&
        r.request().method() === 'POST',
    );
    await manager.getByRole('button', { name: 'Создать агентство' }).click();
    const org = await created;
    expect(org.status()).toBe(201);
    const { id } = (await org.json()) as { id: string };
    const orgBase = '/api/v1/organizations/' + id + '/feeds';
    expect((await page.request.get(orgBase + '/links')).status()).toBe(403);
    await checkFeed(manager, 'XML-выгрузки организации', orgBase);
  } finally {
    await agency.close();
  }
});
