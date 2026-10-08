# Owner publication quota

Issue80 implements the six simultaneously published objects rule from the latest account scenario. Moscow and Moscow Oblast remain the launch geography. This branch builds on registration onboarding PR79; it does not deploy either branch.

## Behavior

Owners consume one slot per distinct published Property ID across their own listings, including organization/API sources. Multiple sale/rental offers for one Property share one slot. Drafts, processing, moderation, paused and terminal listings consume none. Duplicate Property rows remain separate objects; address text is never used to merge them.

Staff publication approval locks the original seller with FOR NO KEY UPDATE before property/listing/case locks, rechecks current activation, registration approval, contacts and role, and counts capacity in the publication transaction. The lock remains compatible with foreign-key KEY SHARE locks. A seventh distinct object returns a bounded quota409 without resolving the case or appending publication history. Staff can retry that same pending request after all published offers of one object are paused.

Existing over-limit publications remain intact; their accurate count and zero remaining capacity are displayed. Additional offers for an already counted Property remain possible. Paid ranking promotions do not buy quota capacity or establish a paid base-publication entitlement.

GET /v1/account/publication-quota reads current account eligibility and caller-only capacity in one database snapshot. Nonowners return null quota fields. The owner-listings panel consumes this endpoint, preserves draft/edit/media/submission controls at capacity, and refreshes after release or explicitly. Failed reads never invent zero capacity. Expired-session401 hides private publication controls;403/503 remain recoverable. A known quota error receives safe client guidance; other backend error details remain hidden.

## Verification

Lint, typecheck, full unit tests and build passed. Web135, API93, script39, shared UI1 and Python5 tests passed. A later UI cleanup changed only captured ref objects; its25 focused tests, typecheck and lint passed, followed by a final web build. The full isolated integration suite passed122 checks. All28 desktop/Android Chromium browser cases passed; scratch database/index/files/process cleanup passed. Six read-load scenarios passed240 measured requests at concurrency4 within the300ms p95 threshold. The final complete built-service smoke chain passed API/web health, registration/staff approval, publication/media/revocation, commerce/professional/trust worker one-shots, search reconciliation, map/selection and SSR detail. Observability and security scans passed; the dependency audit found no known vulnerabilities. Exact-head GitHub CI evidence is recorded separately in the PR.

New real PostgreSQL/HTTP acceptance has16 passing tests, including seller-independent counts, same-Property offers, nonpublic states, accurate legacy over-limit counts, concurrent sixth/seventh approval, same-Property concurrency, fresh locked role/activation/contact/approval state, rejection without mutation, slot release and same-case retry, idempotent replay after pause, republication, organization/API sources, compatible FK locks and a stale actor snapshot. Real HTTP draft creation and moderation submission at full capacity remain available. Captured payment/promotion state is a synthetic policy fixture; no payment provider was exercised.

Before implementation the new tests observed the missing endpoint404, unprotected concurrent approvals, and stale-role publication. Client and UI tests also observed missing quota behavior before implementation. An initial full browser run passed26 cases and failed2 new assertions: the scenario expected a blank form's save button to be enabled after reload. The corrected scenario fills and saves a valid second draft after pausing publication, rather than weakening normal form validation.

Independent whole-feature and security/concurrency reviews found no blocking findings. Their three integration-coverage suggestions were added and passed. A dedicated full-cap/logout browser journey is not included; these combinations have component and real HTTP coverage, while the publication browser journey checks real API/UI counts, draft persistence, staff approval, pause and subsequent draft saving.

## Limits and rollout

No schema changes were needed. Existing seller indexes serve the bounded count; no unmeasured index or migration was introduced, and all16 migration checksums remain unchanged. No real messages, charges, automatic unpublication, destructive account cleanup, merge or remote deployment occurred.

Ownership evidence, three-day conversion to agent, paid publication periods, tariffs, retention, moderation blocks/deletion and numeric SMS remain separate features. Agent publication keeps existing runtime behavior; this change does not claim the proposed paid agent policy is implemented.

Prefer a forward fix. An old binary loses quota admission enforcement; avoid mixed publication workers/API versions during rollout. Reverting quota code does not require data deletion or a migration rollback. Registration policy still has the stronger older-binary caveat described in REGISTRATION_ONBOARDING_VERIFICATION.md; retain migration016 and the approval guard.
