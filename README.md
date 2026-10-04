# RAUI.RU — Foundation

Инфраструктурный monorepo без бизнес-функций.

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
pnpm dev:api
# в другом терминале
pnpm dev:web
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
pnpm build
pnpm smoke # требует запущенные приложения и infra
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
Никаких production migrations, deploy или бизнес-функций в Foundation нет.

## Следующие этапы

Уточнить доменные контракты по утверждённому ТЗ, выбрать ORM и стратегию
миграций, добавить управление секретами и отдельный deployment pipeline.
Настоящее ТЗ пока не хранится в репозитории; Foundation не предполагает
решений о бизнес-модели.
