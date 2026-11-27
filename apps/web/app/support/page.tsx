import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './support.module.css';
import { NewSupportTicket } from '../../components/support-ticket';
import { isSupportTopic, supportUuid } from '../../lib/support';

export const metadata: Metadata = {
  title: 'Служба поддержки — RAUI.RU',
  description:
    'Помощь со входом в кабинет и размещением объявлений на RAUI.RU.',
};

type Question = {
  title: string;
  answer: string;
  keywords: string;
  action?: { label: string; href: string };
};

const commonQuestions: Question[] = [
  {
    title: 'Как войти в нужный аккаунт?',
    answer:
      'Укажите почту, с которой регистрировались, или ID из своего кабинета. Введите пароль. Если в форме входа доступен код, запросите его на почту или телефон, привязанные к этому аккаунту.',
    keywords: 'кабинет логин вход регистрация профиль email',
    action: { label: 'Войти в кабинет', href: '/account' },
  },
  {
    title: 'Как бесплатно разместить объявление?',
    answer:
      'Войдите в кабинет собственника, агента или агентства. Проверьте подтверждение контактов и статус одобрения аккаунта. Откройте форму подачи, выберите категорию, укажите адрес и условия сделки. Добавьте фотографии и отправьте объявление на модерацию. В бесплатной бете для базовых объявлений действуют лимиты вашей роли.',
    keywords: 'подача публикация разместить продажа аренда добавить объект',
    action: {
      label: 'Разместить объявление',
      href: '/account/listings#new-listing',
    },
  },
  {
    title: 'Как правильно указать адрес?',
    answer:
      'Выберите регион, укажите населённый пункт, улицу и номер дома. Нажмите «Найти адрес» и выберите подходящий результат. Проверьте точку на карте. Если поиск недоступен, координаты можно ввести вручную.',
    keywords: 'подача местоположение карта координаты адрес дома',
    action: {
      label: 'Открыть форму подачи',
      href: '/account/listings#new-listing',
    },
  },
  {
    title: 'Не приходит код',
    answer:
      'Проверьте номер телефона или адрес почты в окне подтверждения. Для письма проверьте также папку «Спам». Когда таймер закончится, запросите новый код. Если доставка временно недоступна, вернитесь в форму входа и выберите «Другой способ».',
    keywords: 'вход регистрация смс sms письмо код подтверждения почта',
    action: { label: 'Вернуться ко входу', href: '/account' },
  },
  {
    title: 'Не помню пароль',
    answer:
      'Откройте восстановление доступа и укажите контакт своего аккаунта. Используйте доступный на экране способ подтверждения. Если выбрали ссылку для смены пароля, откройте последнее письмо и задайте новый пароль.',
    keywords: 'вход забыл забыла забыли пароль восстановить доступ сброс',
    action: { label: 'Восстановить доступ', href: '/account/forgot-password' },
  },
];

const moreQuestions: Question[] = [
  {
    title: 'Что проверить перед отправкой объявления на модерацию?',
    answer:
      'Сверьте цену, адрес, контакты и фотографии в предпросмотре. В памятке также указано, как исправить замечание модератора или пожаловаться на объявление.',
    keywords:
      'правила размещения публикации требования к объявлению памятка проверка жалоба',
    action: {
      label: 'Правила размещения объявлений',
      href: '/support/placement-rules',
    },
  },
  {
    title: 'Как изменить контакты в объявлениях?',
    answer:
      'Откройте настройки контактов в кабинете. Проверьте, какие номера выбраны для показа в ваших объявлениях.',
    keywords: 'контакты изменить данные телефон связь профиль',
    action: {
      label: 'Настроить контакты',
      href: '/account?section=contacts#contact-settings',
    },
  },
  {
    title: 'Как исправить замечание модератора?',
    answer:
      'Откройте объект в разделе «Мои объявления». Прочитайте причину отклонения, исправьте указанные данные и сохраните изменения. Проверьте предпросмотр и отправьте объявление на модерацию повторно.',
    keywords: 'модерация отклонено отказ отклонили проверка',
    action: { label: 'Мои объявления', href: '/account/listings' },
  },
  {
    title: 'Как обжаловать решение, если аккаунт заблокирован?',
    answer:
      'Открыть обращение можно без входа. Укажите, какое решение вы просите пересмотреть и почему. Если вопрос касается объявления, приложите ссылку или укажите его номер. После отправки сохраните личную ссылку на обращение. По ней вы сможете прочитать ответ поддержки.',
    keywords:
      'блокировка заблокировали доступ ограничен обжалование пересмотр решения модератора отклонение объявления',
    action: {
      label: 'Обратиться по поводу модерации',
      href: '/support?write=1&topic=moderation',
    },
  },
  {
    title: 'Как добавить фотографии?',
    answer:
      'Сохраните черновик и перейдите к фотографиям. Загрузите снимки объекта и дождитесь окончания обработки. Перед отправкой на модерацию проверьте снимки в предпросмотре.',
    keywords: 'фото изображения снимки загрузка',
    action: { label: 'Открыть мои объявления', href: '/account/listings' },
  },
];

function normalize(value: string) {
  return value.toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    all?: string | string[];
    write?: string;
    topic?: string;
    listing?: string;
  }>;
}) {
  const params = await searchParams;
  const query =
    typeof params.q === 'string' ? params.q.trim().slice(0, 160) : '';
  const showAll = params.all === '1';
  const words = normalize(query).split(/\s+/);
  const questions =
    query || showAll ? [...commonQuestions, ...moreQuestions] : commonQuestions;
  const matches = questions.filter(({ title, answer, keywords }) => {
    const text = normalize(`${title} ${answer} ${keywords}`);
    return words.every((word) => text.includes(word));
  });

  return (
    <main id="content" className={styles.page}>
      <h1>Служба поддержки</h1>
      {params.write === '1' ? (
        <section aria-labelledby="write-title">
          <h2 id="write-title">Напишите нам</h2>
          <NewSupportTicket
            initialTopic={isSupportTopic(params.topic) ? params.topic : 'other'}
            listingId={
              typeof params.listing === 'string' &&
              supportUuid.test(params.listing)
                ? params.listing
                : undefined
            }
            articles={[...commonQuestions, ...moreQuestions]}
          />
        </section>
      ) : (
        <p>
          <Link href="/support?write=1">Напишите нам</Link>
        </p>
      )}
      <form
        className={styles.search}
        role="search"
        action="/support"
        method="get"
      >
        <label htmlFor="support-query">Поиск по справке</label>
        <div>
          <input
            id="support-query"
            name="q"
            type="search"
            defaultValue={query}
            maxLength={160}
            placeholder="Например, не приходит код"
          />
          <button className="primary" type="submit">
            Найти
          </button>
        </div>
      </form>
      <section className={styles.questions} aria-labelledby="questions-title">
        <h2 id="questions-title">
          {query
            ? 'Результаты поиска'
            : showAll
              ? 'Все вопросы'
              : 'Частые вопросы'}
        </h2>
        {matches.map(({ title, answer, action }) => (
          <details key={title}>
            <summary>{title}</summary>
            <p>{answer}</p>
            {action && <Link href={action.href}>{action.label}</Link>}
          </details>
        ))}
        {!matches.length && (
          <p>
            По запросу «{query}» ничего не найдено. Попробуйте другое слово или
            откройте все вопросы.
          </p>
        )}
        {(!showAll || query) && <Link href="/support?all=1">Все вопросы</Link>}
      </section>
    </main>
  );
}
