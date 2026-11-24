import { api } from './client';

export const contactModes = {
  messages: 'Только сообщения',
  both: 'Звонки и сообщения',
  calls: 'Только звонки',
} as const;
export type ContactMode = keyof typeof contactModes;
export type ContactPhone = { id: string; phone: string; primary?: boolean };
export type ContactSettings = { mode: ContactMode; phones: ContactPhone[] };
export type ListingContactSettings = ContactSettings & {
  selectedPhoneIds: string[];
  canEdit: boolean;
};

export async function getListingContactSettings(id: string) {
  const result = await api<ListingContactSettings>(
    `v1/listings/${id}/contact-settings`,
  );
  if (
    !result ||
    !Object.hasOwn(contactModes, result.mode) ||
    !Array.isArray(result.phones) ||
    !Array.isArray(result.selectedPhoneIds)
  )
    throw new Error('Не удалось загрузить контакты объявления.');
  return result;
}

export function visiblePhones(settings: ListingContactSettings) {
  if (settings.mode === 'messages') return [];
  return settings.selectedPhoneIds.flatMap((id) => {
    const selected = settings.phones.find((option) => option.id === id);
    return selected ? [selected] : [];
  });
}
