# Безопасные миграции

Из корня: `pnpm build`, затем `pnpm db:migrate`. Автоматической schema sync
при старте API нет. Runner читает SQL из `apps/api/migrations` в фиксированном
порядке, проверяет SHA-256 ранее применённых файлов, serializes runners через
advisory lock и выполняет каждую миграцию в отдельной транзакции.
Lock timeout 5s, statement timeout 60s. Ошибка откатывает текущий файл полностью.
Применённые SQL менять нельзя: новые изменения — новый migration file.

001 — expand-only: новые таблицы/индексы/constraints, category seeds,
PostGIS extension и append-only audit/history triggers. Foundation tables/data
не изменяются. Extension может потребовать отдельный привилегированный
migration user; runtime DB account должен иметь только нужные DML-права.
Локальный Compose user имеет права для extension/CREATEDB тестов; это не
образец production ACL.

Индексы соответствуют текущим запросам: session token (unique) и user revoke;
membership by user; property owner/org; listing owner/org; listing history;
audit entity/id; pending moderation (unique); queue claim by available_at;
addresses GiST для будущих геозапросов. Search indexes/partitioning не добавлялись.

Rollback приложения: остановить media worker и вернуть previous API artifact;
оставить новые таблицы/данные, старый Foundation ими не пользуется. Запрещено
автоматически DROP новых таблиц после появления данных. Forward-fix — отдельная
миграция по expand → backfill → switch → contract; backfill отдельно от длинных
locking schema operations. Перед production migrations нужны backup/restore
и review конкретного deployment; этот этап ничего в production не применяет.

Тесты проверяют clean apply, repeatability, checksum mismatch и rollback
неудачной миграции. Integration runner создаёт отдельную local DB и удаляет
только её. `pnpm infra:down` сохраняет volume; не используйте `down -v` для
обычного сброса приложения. Audit/history удаления намеренно запрещены даже
локально: для тестов используются изолированные базы.

Phase 3 adds expand-only `002_search_product.sql`; see [search/product rollout](PHASE_3_SEARCH_PRODUCT.md). Migration 001 remains immutable. Integration suites use separate temporary databases and verify repeat execution.

Account launch foundation adds `014_user_public_id.sql` (unique immutable positive
numeric ID, existing UUIDs retained), `015_staff_permissions.sql` (initially empty
named grants), `016_registration_approval.sql`, `017_phone_otp.sql` and
`018_listing_subscriptions.sql` and `019_listing_subscription_inbox.sql`. Auth
returns `public_id` as a decimal string. The
upgrade fixture compares legacy facts separately from these additive fields/tables
and verifies backfill; recovery and release contracts require 21 migrations. Keep
these columns, tables and sequence on application rollback; never reset identifiers
to reuse them.

## Daily in-app expand migration 020

`020_listing_subscription_daily.sql` adds immutable daily event candidates, user/day runs and immutable manifests, plus nullable frequency/run provenance on notifications. Existing message/immediate rows preserve null provenance. Composite foreign keys bind candidate, run and notification to the same recipient; the reader additionally matches the exact candidate envelope and a released manifest. Candidates are captured in the authoritative lifecycle transaction. Bounded worker batches stay hidden until the run's atomic release. Operational candidate TTL applies when inserting the inbox item after final visibility checks, not the lifetime of released history. No historical data or candidate/manifest deletion is introduced.

Daily email is not implemented or enabled. Roll forward migration020; rollback requires a reader that understands020 or explicitly filters daily notifications. Stop the daily producer and coordinator before application rollback; stopping producer alone does not protect a legacy reader from prepared/released daily rows. Preserve all manifest/candidate records. No down migration is supplied.

## Subscription visibility migration 021

`021_subscription_visibility_revisions.sql` adds a consumed generation registry
for seller, organization and membership dependencies. It takes bounded
write-blocking locks in `users → organizations → memberships` order before the
seed snapshot, seeds existing dependencies at generation zero, and installs
transactional invalidation triggers before releasing those locks. Relevant
eligibility changes receive fresh noncycling bigint generations; membership
deletion retains a tombstone so delete/reinsert cannot reset identity.

Availability envelopes created after 021 carry a strict server-owned visibility
token. Missing/corrupt current registry data and stale tokens fail closed. Legacy
availability is accepted only while all required seeded generations are still
zero. Rollback must retain the 021-aware producer, worker, daily coordinator and
inbox reader, or suppress all availability events in every path. Stopping only
new production is insufficient because already queued legacy rows can otherwise
revive after an eligibility cycle. Price-drop/message behavior is unchanged;
global seller/organization/membership event fanout is not supplied by 021.
