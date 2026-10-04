# Этап 2 — доменное ядро RAUI.RU

Основание: `RAUI_MASTER_EXECUTION_PLAN.md`, Phase 2, и `RAUI_TZ_v1.0.md`,
разделы 2–3, 6–10, 12, 18–24, 29–30. Search UX, платежи, продвижение и AI
не входят в реализацию. Web пока сохраняет Foundation: этот этап API-first.

## Границы модулей

- `database`: pool, транзакции и отдельный migration runner.
- `auth`: пользователи, scrypt, одноразовые проверки и серверные сессии.
- `organizations`: agency/developer и contextual membership owner/admin/member.
- `catalog`: категории и настраиваемые scalar/enum attributes.
- `geo`: PostGIS-адреса и интерфейс Geocoder с HTTPS-адаптером.
- `properties`: физический объект; отдельно complex/building/section/floor/unit.
- `listings`: коммерческий оффер, отдельный ListingSource, черновик и lifecycle.
- `media`: ObjectStorage, MediaDelivery, обработка и durable worker.
- `audit`: append-only аудит и история изменений.
- `admin`: защищённые справочники, пользователи, организации, moderation cases,
  аудит, обзор заданий и повтор dead-letter jobs.

Сервисы экспортируются через Nest modules. Controllers не исполняют SQL.
Media зависит только от ListingAccess, а не от listing workflow; workflow
использует Media readiness. PostgreSQL — source of truth, очередь также хранится
в PostgreSQL: transactional enqueue вместе с загрузкой/историей. Redis остаётся
подключённым инфраструктурным компонентом; session cache пока не нужен для
корректности отзыва сессий.

## Модель и права

`Property` ≠ `Listing` ≠ `ListingSource`. Цена/условия/статус принадлежат Listing,
адрес/геометрия/характеристики — Property, provenance — ListingSource.
Один объект может иметь несколько офферов. Для direct оффера source определяется
сервером; organization source определяется типом организации, а не вводом
клиента. Feed/API типы предусмотрены в модели; загрузчики партнёрских фидов —
последующий этап.

Guest — неавторизованный контекст; buyer объединяет buyer/renter. Пользователь
выбирает buyer/owner/agent/agency/developer при регистрации, но не admin.
Для seller writes нужны подтверждённые email и телефон и seller role.
Organization writes дополнительно требуют активных organization и membership.
Owner управляет admin/member, admin управляет только member; нельзя менять
собственную membership или владельца через общий endpoint. Деактивация
membership немедленно запрещает доступ, включая replay idempotency keys.
При деактивации seller/organization или membership оффер также скрывается
из публичного API; история остаётся.

Admin выдаётся только другому пользователю администратором или отдельной
операторской командой после обеих проверок; выдача, отзыв и bootstrap аудируются.
Admin mutations требуют обеих верификаций, защищены от self-demotion и
отзывают сессии изменённого пользователя. Это baseline, не полноценная
админ-панель и не реализация 2FA; extension point отражён в профиле.

## REST/JSON

Контракты: `/v1/openapi.json`, интерактивный справочник `/v1/docs`.

| Группа                  | Операции                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/v1/auth`              | register, login, me, logout, logout-all, sessions/revoke, email/phone verification, password-reset         |
| `/v1/organizations`     | create, mine, members, patch membership                                                                    |
| `/v1/categories`        | public list/attributes; admin attribute configuration                                                      |
| `/v1/geo/geocode?q=...` | authenticated geocoder lookup; 503 при отсутствии провайдера, manual fallback                              |
| `/v1/structures`        | complexes/buildings/sections/floors creation; organization hierarchy                                       |
| `/v1/properties`        | create, authorized read, versioned patch/address correction                                                |
| `/v1/listings`          | create draft, own/org cursor list, private read, published read by id, patch, transitions, source, history |
| `/v1/media`             | validated upload, authorized listing assets, variant delivery                                              |
| `/v1/admin`             | users/organizations/properties/listings, audit, moderation/decision, media jobs/retry                      |

POST domain commands требуют `Idempotency-Key` (8–100 букв/цифр/underscore/hyphen).
Повтор с тем же payload возвращает первоначальный результат после повторной
проверки прав; изменённый payload возвращает 409. PATCH использует `version`
для optimistic concurrency (Property/Listing); set-state admin/membership
операции применяют заданное состояние транзакционно и записывают аудит.
UUID/attributes/body валидируются; SQL параметризован. Лимиты: auth 30/IP/min,
API 300/IP/min, login 15/account/15min. Proxy headers не доверяются по умолчанию.
Ошибки 400/401/403/404/409/429 не раскрывают credentials/SQL. Логи не содержат
body, URL query или токены.

## Auth и проверка контактов

Пароли: scrypt N=32768, r=8, p=1, независимая соль. Пароль 12–128 символов.
Session tokens и verification/reset tokens имеют 256 бит энтропии; в БД только
SHA-256 hashes. Session TTL по умолчанию 7 дней; challenge TTL 15 минут,
одноразовое подтверждение. Reset отзывает все сессии. Auth responses не
возвращают токены проверки и не содержат password_hash.

Login по умолчанию выдаёт HttpOnly/SameSite=Lax cookie (`Secure` в production)
и csrfToken. Для cookie mutations обязательны корректный Origin и
`X-CSRF-Token`. Для API-клиента `transport: "bearer"` выдаёт sessionToken без
cookie; его передают в Authorization. Храните bearer credentials безопасно.

`VerificationDelivery` заменяемый интерфейс. Локальный адаптер кладёт сообщения
в приватный `apps/api/.cache/private/verification/messages.jsonl` (mode 0600),
никогда в API/logs/Git. Только разработчик читает их для локальной проверки.
Реальный адаптер отправляет `{destination,purpose,token}` по HTTPS в настроенный
`VERIFICATION_GATEWAY_URL` с bearer `VERIFICATION_GATEWAY_TOKEN` и timeout 5s.
Это contract адаптера; интеграция конкретного email/SMS-провайдера выполняется
за этим gateway. Продакшен без gateway и S3 storage не запускается.
Geocoder gateway возвращает массив объектов address-schema; настройки токена
опциональны. При отсутствии geocoder ручные координаты доступны без него.

## Черновик → публикация

1. Зарегистрироваться, подтвердить email/phone и войти.
2. Создать Property с category/address и optional attributes; можно сохранять
   неполный набор характеристик. Проверка required attributes — на публикации.
3. Создать Listing с propertyId/dealType. Price/title optional для черновика;
   PATCH autosave требует текущий version.
4. POST `/v1/media` с listingId/kind/filename/mime/base64. JPEG/PNG/WebP, ≤10 MiB,
   ≤40 MP; extension и реальный формат должны совпадать. SVG/анимация запрещены.
5. Worker создаёт thumb 240px, small 800px, large 1600px WebP и AVIF,
   исправляет EXIF orientation, удаляет метаданные и не увеличивает изображения.
6. POST transitions с processing, затем moderation. Последний шаг требует
   готового media, title/price и category attributes; создаёт moderation case.
7. Другой verified admin принимает approve/reject с reason. Автоматика проверяет
   eligibility seller, active membership, version, поля и готовность media.
   Self-moderation запрещена. Approve публикует, reject даёт rejected.
8. Public GET listing/:id/public и media variants разрешены только для
   действительного published offer. Неавторизованные draft images недоступны.

Publisher не может обходить moderation. Published можно paused/archived/sold
(sale)/rented (rent); paused → processing для повторной модерации.
Rejected → draft/processing; processing/moderation можно вернуть в draft.
Terminal archived/sold/rented не переоткрываются. Правки paused/rejected
возвращают draft. Физические параметры нельзя менять при active processing/
moderation/published офферах: сначала pause. Изменения Property заставляют
не-terminal офферы пройти модерацию снова и сохраняют terminal статусы.
Цена, critical fields, status и media фиксируются в listing_history с actor/time;
SQL triggers запрещают UPDATE/DELETE истории и audit.

## Media worker и storage

`pnpm worker:media` запускается отдельно от API. Durable jobs используют
SKIP LOCKED, lease 5min, 3 attempts, exponential retry (10/20/40s) и dead state.
Истёкший lease после исчерпания attempts также попадает в dead-letter.
Admin retry требует idempotency key и аудируется. Обработка идемпотентна по
ключам output, completion защищён attempt fencing. Исходники отделены от variants,
в БД только keys/metadata. При неуспешном enqueue original удаляется; потеря связи
между storage и БД всё ещё требует operator reconciliation после аварии.

ObjectStorage: локальный приватный filesystem или AWS SDK S3-compatible adapter
с ограниченными retry/timeout и обычной SDK credential chain. S3 credentials
никогда не пишутся в `.env.example`. `CDN_BASE_URL` — base reverse-proxy URL
к тем же защищённым variant endpoints, а не публичная ссылка на raw originals.
MediaDelivery выдаёт URL без выдачи storage keys. Proxy обязан сохранять
авторизацию и Cache-Control; приватные ответы не кешировать. Реальные gateway,
S3 и CDN контракты реализованы, но конкретные внешние аккаунты в cloud task
не подключались; acceptance выполнен с local adapters.

## Проверки и ограничения

`pnpm test` — unit/HTTP/architecture checks; `pnpm test:integration` — реальная
изолированная PostgreSQL/PostGIS DB и private storage, полный publication flow,
permissions/CSRF/session revocation, migrations/checksum/atomicity, media retry.
Runner требует localhost DATABASE_URL и запрещает NODE_ENV=production;
создаёт случайную `raui_test_*` DB и удаляет только её. Нужен локальный CREATEDB.
`pnpm smoke` проверяет собранные сервисы, мигрированные categories, OpenAPI,
health/readiness и защищённый admin. CI выполняет оба набора.

Не реализованы Phase 3/4: search/map UX, личный кабинет/UI размещения, billing,
AI, real partner feed ingestion, production rollout. Performance/pentest,
backup/DR и provider-specific operational hardening — отдельные будущие gates.

`pnpm smoke:core` проверяет собранные API и отдельный worker через настоящий local
delivery adapter: verification → object → listing → image → moderation → publish
→ session revoke. Требует запущенный `pnpm worker:media`. Команда разрешена только
для localhost, development DB и local adapters. Создаёт smoke users/offers в локальной
базе; их история намеренно сохраняется. Созданные сессии отзываются. CI также выполняет
эту проверку. Для интеграционных тестов без сохранения данных используйте
`pnpm test:integration` с изолированной тестовой базой.
