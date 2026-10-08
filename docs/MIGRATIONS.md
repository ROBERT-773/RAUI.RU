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

Account launch foundation adds014_user_public_id.sql (unique immutable positive
numeric ID, existing UUIDs retained) and015_staff_permissions.sql (initially empty
named grants). Auth returns public_id as a decimal string. The upgrade fixture
compares legacy facts separately from these additive fields/tables and verifies
backfill; recovery and release contracts require15 migrations. Keep these columns
and sequence on application rollback; never reset identifiers to reuse them.
