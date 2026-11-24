import {
  contactModes,
  visiblePhones,
  type ListingContactSettings,
} from '../lib/contact-settings';

function ProfileLink() {
  return (
    <a
      href="/account?section=contacts#contact-settings"
      target="_blank"
      rel="noopener noreferrer"
    >
      Настройки связи в профиле
    </a>
  );
}

export function PreviewContacts({
  settings,
}: {
  settings: ListingContactSettings;
}) {
  const phones = visiblePhones(settings);
  return (
    <section aria-label="Способы связи">
      <h3>Способы связи</h3>
      {settings.mode !== 'calls' && <p>Сообщение на портале</p>}
      {phones.map((phone, index) => (
        <p key={phone.id}>
          Телефон {index + 1}: {phone.phone}
        </p>
      ))}
      {settings.mode === 'calls' && !phones.length && (
        <p>
          {settings.canEdit
            ? 'Телефон для звонков ещё не выбран.'
            : 'Публичный номер пока недоступен.'}
        </p>
      )}
      {settings.canEdit === false ? (
        <p>Способ связи задаёт автор объявления.</p>
      ) : (
        <p>
          <ProfileLink />
        </p>
      )}
    </section>
  );
}

export default function ListingContacts({
  settings,
  disabled,
  onSelect,
  onRetry,
}: {
  settings: ListingContactSettings | null;
  disabled: boolean;
  onSelect: (ids: string[]) => void;
  onRetry: () => void;
}) {
  if (!settings)
    return (
      <section aria-label="Контакты объявления">
        <h3>Контакты объявления</h3>
        <p>Не удалось загрузить контакты.</p>
        <button type="button" disabled={disabled} onClick={onRetry}>
          Обновить контакты
        </button>
      </section>
    );
  if (settings.canEdit === false)
    return <PreviewContacts settings={settings} />;
  return (
    <section aria-label="Контакты объявления">
      <h3>Контакты объявления</h3>
      <p>
        {contactModes[settings.mode]}. <ProfileLink />
      </p>
      {settings.mode === 'messages' && (
        <p>При этом режиме посетители видят только возможность написать.</p>
      )}
      {settings.phones.length > 0 ? (
        <fieldset disabled={disabled}>
          <legend>Номера для этого объявления</legend>
          <p>Можно выбрать до двух. Выбор сохраняется сразу.</p>
          {settings.phones.map((option) => {
            const index = settings.selectedPhoneIds.indexOf(option.id);
            const checked = index !== -1;
            return (
              <label key={option.id} className="listing-option">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && settings.selectedPhoneIds.length >= 2}
                  onChange={() =>
                    onSelect(
                      checked
                        ? settings.selectedPhoneIds.filter(
                            (id) => id !== option.id,
                          )
                        : [...settings.selectedPhoneIds, option.id],
                    )
                  }
                />
                {checked && `Телефон ${index + 1}: `}
                {option.phone}
              </label>
            );
          })}
        </fieldset>
      ) : (
        <p>Подтвердите контактный номер в профиле продавца.</p>
      )}
      <button type="button" disabled={disabled} onClick={onRetry}>
        Обновить контакты
      </button>
    </section>
  );
}
