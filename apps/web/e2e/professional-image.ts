import { expect, type Locator, type Page } from '@playwright/test';

type Sample = 'portrait' | 'logo';

async function uploadSample(page: Page, input: Locator, kind: Sample) {
  const encoded = await page.evaluate((sample) => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const ctx = canvas.getContext('2d')!;
    if (sample === 'portrait') {
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, 40, 40);
    }
    ctx.fillStyle = 'blue';
    ctx.fillRect(40, 0, 40, 40);
    return canvas
      .toDataURL(sample === 'portrait' ? 'image/jpeg' : 'image/png')
      .split(',')[1]!;
  }, kind);
  let buffer = Buffer.from(encoded, 'base64');
  if (kind === 'portrait') {
    // EXIF orientation 6 rotates the red left half to the top of a vertical portrait.
    const exif = Buffer.from(
      'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
      'hex',
    );
    buffer = Buffer.concat([buffer.subarray(0, 2), exif, buffer.subarray(2)]);
  }
  await input.setInputFiles({
    name: kind === 'portrait' ? 'portrait.jpg' : 'logo.png',
    mimeType: kind === 'portrait' ? 'image/jpeg' : 'image/png',
    buffer,
  });
}

async function checkPixels(image: Locator, kind: Sample) {
  await expect(image).toBeVisible();
  await image.scrollIntoViewIfNeeded();
  const pixels = await image.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const pixel = (fraction: number) =>
      Array.from(
        ctx.getImageData(
          canvas.width * fraction,
          canvas.height * fraction,
          1,
          1,
        ).data,
      );
    return {
      size: [canvas.width, canvas.height],
      first: pixel(0.25),
      last: pixel(0.75),
    };
  });
  expect(pixels.size).toEqual(kind === 'portrait' ? [40, 80] : [80, 40]);
  if (kind === 'portrait') expect(pixels.first[0]).toBeGreaterThan(220);
  else expect(pixels.first[3]).toBe(0);
  expect(pixels.last[2]).toBeGreaterThan(220);
  expect(pixels.last[3]).toBe(255);
}

export async function checkProfessionalImage(
  editor: Page,
  visitor: Page,
  listingId: string,
  agencyId?: string,
) {
  const alt = agencyId ? 'Логотип агентства' : 'Фото агента';
  const noun = agencyId ? 'логотип' : 'фото';
  const ownerPath =
    '/api/v1/search/professional-profile' +
    (agencyId ? '/agency/' + agencyId : '');
  const name = (agencyId ? 'Агентство' : 'Агент') + ' ' + listingId;
  const listing = '/listings/' + listingId;
  const role = agencyId ? 'Агентство недвижимости' : 'Агент по недвижимости';
  await editor.goto('/account');
  if (agencyId)
    await editor
      .getByRole('combobox', { name: 'Агентство', exact: true })
      .selectOption(agencyId);
  await editor
    .getByText(
      agencyId ? 'Публичный профиль агентства' : 'Публичный профиль агента',
      { exact: true },
    )
    .click();
  await editor.getByLabel('Публичное имя').fill(name);
  await editor.getByLabel('Регионы работы').selectOption('moscow');
  const publish = async (visible: boolean) => {
    await editor.getByLabel('Показывать в каталоге').setChecked(visible);
    const saved = editor.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === ownerPath &&
        r.request().method() === 'PATCH',
    );
    await editor
      .getByRole('button', { name: 'Сохранить профиль', exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
  };
  await publish(true);
  const controls = editor.getByRole('region', { name: alt, exact: true });
  await expect(controls).toBeVisible();
  const card = visitor.getByRole('region', {
    name: 'Кто разместил объявление',
  });
  const link = card.getByRole('link', { name, exact: true });
  const visitorImage = visitor.getByRole('img', { name: alt, exact: true });
  const upload = async (kind: Sample, replacing: boolean) => {
    await uploadSample(
      editor,
      controls.getByLabel('Файл изображения', { exact: true }),
      kind,
    );
    const saving = editor.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === ownerPath + '/image' &&
        r.request().method() === 'PUT',
    );
    await controls
      .getByRole('button', {
        name: (replacing ? 'Заменить ' : 'Загрузить ') + noun,
        exact: true,
      })
      .click();
    expect((await saving).ok()).toBe(true);
    await visitor.goto(listing);
    await expect(
      visitor
        .getByRole('heading', { name: 'Связаться с продавцом', exact: true })
        .or(card.getByRole('heading')),
    ).toHaveText(['Связаться с продавцом', 'Кто разместил объявление']);
    await checkPixels(card.getByRole('img', { name: alt, exact: true }), kind);
    const src = await visitorImage.getAttribute('src');
    expect(src).toMatch(
      /^\/api\/v1\/search\/professionals\/[\da-f-]+\/image\/[\da-f-]+$/,
    );
    await link.click();
    await expect(
      visitor.getByRole('heading', { level: 1, name, exact: true }),
    ).toBeVisible();
    await expect(visitorImage).toHaveAttribute('src', src!);
    await checkPixels(visitorImage, kind);
    const media = await visitor.request.get(src!);
    expect(media.status()).toBe(200);
    expect(media.headers()['content-type']).toMatch(/^image\/webp/);
    expect(media.headers()['cache-control']).toMatch(/\bno-store\b/);
    return src!;
  };
  const cachedStatus = (src: string) =>
    visitor.evaluate(async (url) => (await fetch(url)).status, src);
  const first = await upload(agencyId ? 'logo' : 'portrait', false);
  const second = await upload(agencyId ? 'portrait' : 'logo', true);
  expect(second).not.toBe(first);
  expect(await cachedStatus(first)).toBe(404);
  const profilePath = new URL(visitor.url()).pathname;
  await publish(false);
  await visitor.goto(listing);
  await expect(card.getByText(role, { exact: true })).toBeVisible();
  await expect(link).toHaveCount(0);
  await expect(card.getByRole('img', { name: alt })).toHaveCount(0);
  expect((await visitor.request.get(profilePath)).status()).toBe(404);
  expect(await cachedStatus(second)).toBe(404);
  await publish(true);
  await visitor.goto(listing);
  await expect(card.getByRole('img', { name: alt })).toHaveAttribute(
    'src',
    second,
  );
  const deleting = editor.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.startsWith(ownerPath + '/image/') &&
      r.request().method() === 'DELETE',
  );
  await controls
    .getByRole('button', { name: 'Удалить ' + noun, exact: true })
    .click();
  expect((await deleting).ok()).toBe(true);
  await visitor.reload();
  await expect(card.getByRole('img', { name: alt })).toHaveCount(0);
  await link.click();
  await expect(
    visitor.getByRole('heading', { level: 1, name, exact: true }),
  ).toBeVisible();
  await expect(visitorImage).toHaveCount(0);
  expect(await cachedStatus(second)).toBe(404);
}
