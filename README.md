# RAUI.RU

Проект недвижимости RAUI.RU. Foundation завершён; API-first ядро Этапа 2 подготовлено для ревью. Дальнейшая разработка ведётся по поэтапному плану и техническому заданию.

Актуальные управляющие документы:

- `docs/RAUI_MASTER_EXECUTION_PLAN.md` — поэтапный план разработки;
- `docs/RAUI_TZ_v1.0.md` — техническое задание;
- GitHub Issues — рабочие задачи текущего этапа.

Реализация Этапа 2: [модули, API и проверки](docs/PHASE_2_CORE.md),
[миграции и rollback/forward-fix](docs/MIGRATIONS.md).

## Структура

- `apps/web`: Next.js App Router, React, TypeScript; `/health`.
- `apps/api`: NestJS; `/health` — liveness, `/health/ready` — PostgreSQL/PostGIS и Redis; при сбое возвращается 503 без деталей соединения.
- `apps/ai`: Python scaffold и unit-тест; сетевой сервис пока не запускается.
- `packages/config`: общая strict TypeScript-конфигурация.
- `packages/types`: общие типы контрактов.
- `packages/ui`: базовые UI primitives.
- `infra`: локальные PostgreSQL + PostGIS и Redis с persistent volumes.

## Требования и запуск

Node.js 24 (см. `.nvmrc`), pnpm 10.0.0, Python 3.12+, Docker Engine с Compose v2.
Активируйте pnpm через `corepack enable && corepack prepare pnpm@10.0.0 --activate`.
В опубликованной облачной среде можно использовать уже установленный pnpm:
`export PATH="/workspace/.raui-tools/node_modules/.bin:$PATH"`.

Из корня репозитория:

```sh
pnpm install --frozen-lockfile
cp .env.example .env # только если локального файла ещё нет
pnpm infra:up
pnpm build
pnpm db:migrate
pnpm dev:api
# в другом терминале
pnpm dev:web
# media worker в отдельном терминале
pnpm worker:media
```

API watch отслеживает `dist`; при разработке API запустите дополнительно
`pnpm --filter @raui/api exec tsc -p tsconfig.build.json --watch`.
Web: порт 3000, API: 3001. Сервисы слушают loopback; production deployment
должен явно определить bind address, TLS, секреты и сетевую изоляцию.
Для smoke production-сборки используйте `pnpm --filter @raui/api start`
и `pnpm --filter @raui/web start` в отдельных терминалах, затем `pnpm smoke`.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration # изолированная local DB; требуется CREATEDB
pnpm build
pnpm smoke # требует запущенные приложения и infra
pnpm smoke:core # также требует отдельный media worker; создаёт local smoke fixtures
pnpm infra:down # сохраняет данные
```

`pnpm format` исправляет форматирование. CI выполняет все проверки и smoke.
Health liveness не зависит от доступности внешних сервисов; readiness проверяет
настоящий PostGIS и Redis. Python scaffold не требует сторонних библиотек.

## Конфигурация и безопасность

`.env.example` содержит только локальные значения. `.env` не коммитится.
API валидирует обязательные URL и порт при запуске. DATABASE_URL и REDIS_URL
используются только сервером; не добавляйте их в NEXT_PUBLIC_*.
Образы Compose закреплены digest; обновляйте их осознанно вместе с проверками.
Compose предназначен исключительно для локальной разработки: порты доступны
на 127.0.0.1; пароль примера нельзя использовать вне локального окружения.
PostGIS включается стандартной инициализацией образа на новом volume.
Для существующей базы проверьте наличие расширения отдельно.
Production migrations/deploy не выполняются. Локальные verification/storage
adapters запрещены при NODE_ENV=production; см. документацию Этапа 2.

## Текущий процесс разработки

Работа ведётся по этапам из `docs/RAUI_MASTER_EXECUTION_PLAN.md`.
Перед реализацией бизнес-функций сверяйтесь с `docs/RAUI_TZ_v1.0.md` и задачей текущего этапа.
Каждый этап выполняется в отдельной ветке, проходит обязательные проверки и завершается Pull Request в `master`.

После Этапа 2 разработка останавливается до отдельного разрешения на Этап 3.

Phase 3 search/product setup, API, privacy, tests and rollback: [docs/PHASE_3_SEARCH_PRODUCT.md](docs/PHASE_3_SEARCH_PRODUCT.md).

Phase 4B professional integrations: see [the implementation report](docs/PHASE4B_REPORT.md)
for feed contracts, scheduled retrieval, scoped partner tokens, notification delivery,
local verification and rollback. Run `pnpm worker:professional` alongside the existing
API/search/media/commerce workers; `pnpm worker:professional --once` runs one bounded
notification/import pass. External feeds and delivery gateways require explicit
server-side configuration; local tests do not send real notifications.
