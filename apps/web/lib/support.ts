export const supportTopics = {
  login: 'Вход и регистрация',
  listing: 'Подача и адрес',
  moderation: 'Модерация',
  photos: 'Фотографии',
  complaint: 'Жалоба на объявление',
  ownership: 'Жалоба от собственника',
  xml: 'XML-выгрузка',
  commercial: 'Коммерческая недвижимость',
  other: 'Другая тема',
} as const;
export type SupportTopic = keyof typeof supportTopics;
export function isSupportTopic(value: unknown): value is SupportTopic {
  return typeof value === 'string' && Object.hasOwn(supportTopics, value);
}
export interface SupportTicket {
  id: string;
  topic: SupportTopic;
  message: string;
  listingId: string | null;
  createdAt: string;
  repliedAt: string | null;
  reply: string | null;
}
export const supportUuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
