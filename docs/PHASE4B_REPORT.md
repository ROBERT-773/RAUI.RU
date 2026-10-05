# Phase 4B implementation report

Branch: `feat/phase-4b-professional-integrations` · PR: [#28](https://github.com/ROBERT-773/RAUI.RU/pull/28) · Issue: [#24](https://github.com/ROBERT-773/RAUI.RU/issues/24).

Built on accepted Phase 4A (`db4e897`) and the existing Phase 4B implementation. Parallel remote changes through `0112ef4` are retained. No production deployment or direct master writes.

## Scope checklist

| Phase 4B requirement        | Implementation and evidence                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agency/developer tooling    | Existing organization/membership context; verified sellers; named portfolios and authorized reads/writes.                                                                                          |
| Portfolio/bulk operations   | All-or-nothing bulk pause, deterministic locks, contextual management permission, idempotent replay and immutable listing history/audit.                                                           |
| Developer hierarchy         | Existing `StructuresModule` reused and exported; complex/building/section/floor plus bounded physical units/offers. No parallel hierarchy model.                                                   |
| Feed definitions/schedules  | Existing feed definitions extended with optimistic version and due time; professional worker schedules approved HTTPS feeds.                                                                       |
| Validation/dry-run          | Same strict normalized schema/category/attribute checks as apply; queued dry-run writes logs only, never Property/Listing/ListingSource.                                                           |
| Imports/upsert/reprocessing | Durable jobs, per-row transactions/savepoints, leases, persisted fetched snapshots, request idempotency, canonical fingerprints, FIFO per feed and bounded retry/DLQ.                              |
| Source tracking/quarantine  | Feed-specific source namespace and durable feed/reference binding; duplicates/invalid data/private-state conflicts logged in quarantine. Identical external IDs in separate feeds remain distinct. |
| Logs/metrics                | Paged run/item APIs; accepted/quarantined totals, attempts, due time, generic error codes and audited completion. Raw payloads are private server-side records.                                    |
| Partner authorization       | Existing partner clients extended with expiry/revocation; digest-only storage, token shown once, scoped endpoints, organization/membership/verification checks and per-key rate limits.            |
| Notification delivery       | Existing delivery worker extended with stable provider idempotency key, deadline, leases/fencing, retries/DLQ, verified destinations and preference recheck. Product outbox bridge is idempotent.  |
| Notification preferences    | Existing migration-002 preferences preserved, including email/SMS/push opt-out defaults; transactional setting additionally restricts delivery.                                                    |
| Admin controls/audit        | Protected feed controls/run inspection/retry, partner inspection/revocation, delivery inspection/retry. Critical changes and worker transitions use append-only audit.                             |

## API and operational flow

Existing `/v1/organizations/{organizationId}/feeds` and professional/partner routes are preserved and extended. Request contracts and partner token authentication are documented in `/v1/openapi.json` and `/v1/docs`.

- `POST .../feeds/{feedId}/dry-run` and `/apply` accept `{items:[...]}` plus `Idempotency-Key`; return `{runId,status:"queued"}`. Both are asynchronous. Run `pnpm worker:professional` continuously and read `/runs` and `/runs/{runId}/items` for results. Heavy batches never run in HTTP transactions.
- A normalized row supplies `externalReference`, `categoryCode`, `dealType`, `title`, `price`, optional description/attributes, and an explicit address object with locality/longitude/latitude. Coordinates are never guessed.
- New feed offers are private drafts. Changed offers must be draft/paused/rejected. Active/terminal offers quarantine; publication remains the existing moderation workflow.
- Physical identity is stable. Changed physical facts quarantine and require the existing versioned Property editing workflow; feeds cannot silently replace or overwrite shared physical objects.
- Unchanged normalized rows do not increment offer/property versions or create extra addresses. Completed rows survive worker restart; retry skips them. Request-key payload mismatch returns 409.
- JSON arrays, CSV headers and `<feed><item>...</item></feed>` XML are supported for scheduled retrieval. `mapping` maps output dotted fields to input dotted paths; numeric price/coordinates/area convert explicitly. Entity/DTD XML, unsafe prototype paths, invalid rows and oversized batches are rejected.
- HTTPS feeds require an exact `FEED_ALLOWED_HOSTS` allowlist. Private/reserved/link-local addresses, IP-literal hosts, URL credentials, redirects and non-HTTPS endpoints are blocked. DNS results are validated and pinned for the request; TLS hostname validation stays enabled. DNS resolution has a 3-second deadline; retrieval has a 10-second/2-MB bound. IPv6 feed fetching is deliberately denied pending an equivalent address policy.
- Supported UTC schedules: `*/N * * * *` for N = 5, 10, 15, 20, 30, 60; `0 * * * *`; `0 0 * * *`. Next due time aligns with the UTC boundary. Other expressions are rejected explicitly, including unsafe legacy schedules.
- Partners send `X-Partner-Token`. Scopes are `listings:read`, `listings:write` (bulk pause), `feeds:write` (queued apply); every operation stays inside the key organization. Key expiry defaults to 90 days; configured expiry must be within one year. Creation replay returns metadata with `token:null`; plaintext is never stored in idempotency responses or audit.
- Product notification outbox feeds the existing delivery table with a stable unique dedupe key. Successful/disabled deliveries update the original outbox too. Notification retries keep the same provider key. An unconfigured gateway defers without consuming retry attempts or pretending delivery succeeded.
- Configure `NOTIFICATION_GATEWAY_URL` and its server-side token only through environment/secrets management. The HTTPS gateway must honor `Idempotency-Key` across ambiguous failures/retries and resolve push subscriptions for the supplied user ID. No real delivery credentials are required for local acceptance tests; live provider certification remains an enablement prerequisite.

## Migrations and compatibility

- Phase 4B migrations 005/006/007 remain the feed/workflow/partner foundation.
- **006 was corrected before its first application:** it previously tried to recreate `notification_preferences` already created by 002. It now expands that existing table without resetting preference values and supports SMS deliveries. This correction affects proposed, unmerged Phase 4B SQL; applied master migrations 001–004 are unchanged, as are 005 and 007.
- New `008_professional_operations.sql` adds job leases, source bindings, schedule/version fields, notification fencing and partner expiry. It backfills traceable historical feed sources without replacing source/property/listing IDs. No domain table/row is dropped.
- All migrations apply from an empty isolated PostgreSQL/PostGIS database, apply twice without changes, and apply to the existing local Phase 4A database. Core checksum/atomicity regression tests remain enabled.
- Any environment that previously applied the defective draft 006 outside the supported local workflow must reconcile that draft checksum explicitly before upgrading; never overwrite an applied migration record or production data to bypass checks.

## Verification

Required gates are retained, including mandatory Prettier and the full existing GitHub Actions browser matrix. An E2E race in saved-search confirmation was fixed: saving waits until navigation/results finish; the scenario verifies the committed filtered route before saving. Concurrent partner requests also have a PostgreSQL regression test for lock-upgrade deadlocks.

- `pnpm lint` — ESLint + Prettier.
- `pnpm typecheck` — all strict TypeScript workspaces.
- `pnpm test` — 32 API, 3 web, 1 UI, 1 Python tests.
- `pnpm test:integration` — 62 node-reported tests across core (15), search (11), commerce (15), professional (21), including parent tests. Each suite uses a fresh local database removed on completion.
- `pnpm build` — API and optimized Next.js artifacts.
- `pnpm db:migrate` — local database only.
- `pnpm smoke`, `pnpm smoke:core`, `pnpm search:reconcile`, `pnpm smoke:search` — running built API/web/media artifacts and real local services.
- `pnpm worker:commerce --once`, `pnpm worker:professional --once` — actual standalone worker bootstrap/execution.
- `CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` — 12 desktop/Android Chromium flows locally; remote CI retains the broader browser matrix.

Professional acceptance specifically covers duplicate/invalid dry-run, category/attribute validation, upsert replay and identity, cross-feed references, active-offer protection, concurrent enqueue/FIFO, portfolio rollback/member permissions, every developer hierarchy level, key hash/one-time reveal/scopes/rate/expiry/revocation/membership/concurrent usage, cross-organization denial, scheduled imports/backoff/DLQ/admin retry, stale import lease, product outbox bridge/concurrent deduplication, preference suppression, unconfigured adapter behavior, notification DLQ/fencing, OpenAPI and immutable admin audit.

## Rollback and next gate

Pause feeds with their versioned active control; revoke partner clients; stop the professional worker or unset the notification gateway. Keep additive schema and trace/audit data. Use a forward migration for later schema fixes; never edit applied SQL or delete durable logs to roll back code.

Merge readiness requires green GitHub Actions on the pushed head and resolution of review findings. Production rollout/credentials are not part of this task. After confirmed PR #28 merge, fetch fresh master and continue `docs/PHASE4C_AI_TRUST_SPEC.md` as instructed; do not begin Phase 4C on an unmerged Phase 4B base.

## Notification gateway regression follow-up (PR #28)

The existing unsafe-destination regression was reproduced on `f0c79d2` without changing its assertions. WHATWG `URL.hostname` retains brackets around IPv6 literals, so `isIP('[::1]')` returns zero and the URL validator incorrectly accepted loopback IPv6. Production validation now rejects bracketed IPv6 hosts as well as IPv4 literals; the regression retains every original unsafe URL and DNS-answer case and adds diagnostic exception matching.

A transport regression also reproduced `agent.dispatch is not a function`: Node's native `fetch` expects an Undici dispatcher, not `node:https.Agent`. The gateway now uses `node:https.request` with a validated, pinned IPv4 lookup, explicit `family: 4`, the original TLS server name, certificate verification, no pooled connection reuse, and the worker's abort signal. Explicit IPv4 avoids Node 24 requesting an incompatible all-address lookup result. Redirects and every response other than 200/201/204 fail; response bodies are discarded and transport errors remain generic. Stable provider idempotency keys and worker retry/preferences/fencing behavior are unchanged.

The new transport test verifies the pinned socket address, TLS identity/verification, IPv4 family, abort signal, request payload and idempotency header. It proves that a subsequent DNS answer rebinding to loopback is rejected before another request is opened, and that redirects fail. Network/DNS boundaries are mocked so the unit test never contacts a provider or uses real credentials. Existing PostgreSQL/HTTP notification acceptance tests remain enabled.

No migrations, dependencies, production configuration or deployment are part of this correction. Rollback by reverting the code commit would restore the diagnosed security/transport defects; prefer a forward fix. CodeGuard review is a separate outstanding gate: no CodeGuard tool/skill/CLI is exposed in this environment, and the GitHub reviews API returns `Forbidden`. Local checks or an inline inspection must not be presented as a completed CodeGuard review. No merge is authorized for this follow-up.
