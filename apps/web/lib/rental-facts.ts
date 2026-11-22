import type { PublicRentalTerms } from '@raui/types/product';
import { attributeValue } from './labels';

export function rentalFacts(
  terms: PublicRentalTerms | Record<string, unknown>,
) {
  const {
    availableFrom,
    availableUntil,
    deposit,
    commission,
    utilitiesIncluded,
    guestCapacity,
    minimumNights,
  } = terms;
  const from =
    typeof availableFrom === 'string' ? new Date(availableFrom) : null;
  const until =
    typeof availableUntil === 'string' ? new Date(availableUntil) : null;
  return [
    [
      'Даты заезда и выезда',
      from &&
      until &&
      Number.isFinite(from.getTime()) &&
      Number.isFinite(until.getTime()) &&
      from <= until
        ? new Intl.DateTimeFormat('ru-RU', {
            dateStyle: 'long',
            timeZone: 'UTC',
          }).formatRange(from, until)
        : undefined,
    ],
    [
      'Залог',
      typeof deposit === 'number'
        ? deposit.toLocaleString('ru-RU') + ' ₽'
        : undefined,
    ],
    [
      'Комиссия',
      typeof commission === 'number'
        ? commission.toLocaleString('ru-RU') + ' %'
        : undefined,
    ],
    [
      'Коммунальные платежи включены',
      typeof utilitiesIncluded === 'boolean'
        ? attributeValue(utilitiesIncluded)
        : undefined,
    ],
    [
      'Максимум гостей',
      typeof guestCapacity === 'number' ? guestCapacity : undefined,
    ],
    [
      'Минимум ночей',
      typeof minimumNights === 'number' ? minimumNights : undefined,
    ],
  ].flatMap(([label, value]) =>
    typeof label === 'string' && value !== undefined ? [{ label, value }] : [],
  );
}
