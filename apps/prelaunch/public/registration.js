/* global document, FormData, fetch */
'use strict';

const form = document.querySelector('#launch-form');
const phone = document.querySelector('#launch-phone');
const submit = document.querySelector('#submit');
const error = document.querySelector('#form-error');
const success = document.querySelector('#success');

function nationalPart(value) {
  const compact = value.replace(/[\s()-]/g, '');
  const full = /^(?:\+7|[78])(\d{10})$/.exec(compact);
  return full ? full[1] : value;
}

phone.addEventListener('input', () => {
  phone.setCustomValidity('');
  const national = nationalPart(phone.value);
  if (national !== phone.value) phone.value = national;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const digits = nationalPart(phone.value).replace(/[\s()-]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    phone.setCustomValidity('Введите 10 цифр номера после +7.');
    phone.reportValidity();
    return;
  }
  const values = new FormData(form);
  const body = {
    email: String(values.get('email')).trim(),
    phone: '+7' + digits,
    consent: values.get('consent') === 'on',
  };
  submit.disabled = true;
  submit.textContent = 'Сохраняем заявку…';
  error.hidden = true;
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 400)
        throw new Error('Проверьте почту, телефон и согласие на уведомление.');
      if (response.status === 429)
        throw new Error('Слишком много попыток. Попробуйте немного позже.');
      throw new Error('Не удалось сохранить заявку. Попробуйте ещё раз.');
    }
    const data = await response.json().catch(() => null);
    if (data?.accepted !== true)
      throw new Error(
        'Не удалось подтвердить сохранение заявки. Попробуйте ещё раз.',
      );
    form.reset();
    form.hidden = true;
    document.querySelector('#instructions').hidden = true;
    success.hidden = false;
    success.focus();
  } catch (failure) {
    error.textContent =
      failure instanceof TypeError
        ? 'Проверьте соединение и отправьте заявку ещё раз.'
        : failure.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Зарегистрироваться до открытия';
  }
});
form.hidden = false;
