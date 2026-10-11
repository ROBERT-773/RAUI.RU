export type ListingEmailEvent =
  | { kind: 'subscribed' }
  | { kind: 'price_drop'; previousPriceMinor: number; priceMinor: number }
  | { kind: 'availability'; available: boolean };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]!;
  });
}

function rubles(minor: number) {
  if (!Number.isSafeInteger(minor) || minor <= 0)
    throw new Error('Invalid email price');
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
  }).format(minor / 100);
}

/** Pure renderer; delivery and current subscription consent are checked by the worker. */
export function renderListingEmail(input: {
  siteOrigin: string;
  listingId: string;
  title: string;
  event: ListingEmailEvent;
}) {
  const origin = new URL(input.siteOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Invalid email site origin');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.listingId,
    )
  )
    throw new Error('Invalid email listing id');
  const title = input.title.trim();
  if (
    !title ||
    title.length > 200 ||
    Array.from(input.title).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid email listing title');
  let heading: string;
  let description: string;
  switch (input.event.kind) {
    case 'subscribed':
      heading = 'Подписка на объявление включена';
      description = 'Вы подписались на изменения этого объявления.';
      break;
    case 'price_drop': {
      const previous = rubles(input.event.previousPriceMinor);
      const current = rubles(input.event.priceMinor);
      if (input.event.priceMinor >= input.event.previousPriceMinor)
        throw new Error('Price decrease required');
      heading = 'Цена объявления снизилась';
      description = `Предыдущая цена: ${previous}. Новая цена: ${current}.`;
      break;
    }
    case 'availability':
      heading = input.event.available
        ? 'Объявление снова доступно'
        : 'Объявление больше не доступно';
      description = input.event.available
        ? 'Проверьте актуальные условия на странице объявления.'
        : 'Объявление сейчас недоступно. Причины и личные сведения продавца не раскрываются.';
      break;
  }
  const listingUrl = new URL(`/listings/${input.listingId}`, origin).href;
  const settingsUrl = new URL('/account', origin).href;
  const available =
    input.event.kind !== 'availability' || input.event.available;
  const actionUrl = available ? listingUrl : settingsUrl;
  const action = available ? 'Открыть объявление' : 'Открыть аккаунт';
  const text = `${heading}\n\n${title}\n${description}\n\n${action}: ${actionUrl}\nНастройки уведомлений: ${settingsUrl}\n\nRAUI.RU`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><main><p>RAUI.RU</p><h1>${escapeHtml(heading)}</h1><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><p><a href="${escapeHtml(actionUrl)}">${action}</a></p><p><a href="${escapeHtml(settingsUrl)}">Настройки уведомлений</a></p></main></body></html>`;
  return { subject: `RAUI.RU — ${heading}`, text, html, templateVersion: 1 };
}
