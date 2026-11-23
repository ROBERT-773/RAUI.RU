export function normalizePhoneInput(value: string) {
  const compact = value.replace(/[\s()-]/g, '');
  const phone = /^8[0-9]{10}$/.test(compact)
    ? '+7' + compact.slice(1)
    : compact;
  return /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : null;
}

export const invalidPhoneInput =
  'Введите номер с кодом страны, например +7 999 123-45-67.';
