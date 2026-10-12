# Issue107 — local verification report

Date:2026-10-12 (Europe/Moscow). Branch:`fix/issue-107` in
`/workspace/raui-107`, based on PR98 SHA
`77039fab34f9b6f34c4d2e7d20f899880dd23aa8`.
The final local commit is available through `git log -1` in this checkout;
there is no remote commit/PR URL because push was not authorized.

## Outcome

All three Issue106 findings are addressed in this local candidate:

1. Authoritative listing lifecycle/history commits enqueue immediate email
   events. Only email/immediate is accepted and offered. Daily/in_app are explicit
   follow-ups, with legacy-data warnings rather than delivery promises.
2. Version-protected create/update/resume and disable prevent stale reactivation.
   Worker validates exact consent, public/seller/recipient/global-preference
   eligibility and serializes send against their withdrawal. Finalization reuses
   its transaction, avoiding pool exhaustion from nested transactions.
3. The own-account quota and UI expose monthly usage, remaining allowance and
   Moscow reset, and distinguish monthly exhaustion from active-slot release.

No SQL migration was added or modified. Complete001–018 remains required.
Two independent read-only reviewers found no remaining blockers in their reviewed
security and quota/UI scope, conditional on checks. These are local reviewer
reports, not submitted GitHub approval reviews.

## Checks actually executed

Toolchain:Node24.19.0, pnpm10.0.0. Commands from repository root unless stated.

| Command                                               | Result / evidence                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                      | PASS; unchanged lockfile                                                                        |
| `pnpm lint`                                           | PASS; ESLint and Prettier                                                                       |
| `pnpm typecheck`                                      | PASS                                                                                            |
| `pnpm test`                                           | PASS:API133, API scripts40, web192, UI1, Python5, runtime16; no failed/skipped tests            |
| `pnpm build`                                          | PASS:API and Next production build                                                              |
| `pnpm security:check`                                 | PASS:credential/TLS/client-boundary scan and dependency audit; no known vulnerabilities         |
| `pnpm observability:check`                            | PASS:7 alert rules                                                                              |
| `pnpm test:integration`                               | PASS:163 tests across12 PostgreSQL suites, zero failures/skips; fresh scratch DBs cleaned       |
| targeted subscriptions integration supplement         | PASS:9 tests after extending real HTTP withdrawal to re-moderation/publication; no mock enqueue |
| `CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` | PASS:32 desktop/Android Chromium tests, plus runner critical-read load240 requests              |
| `pnpm db:migrate` twice                               | PASS:idempotent001–018 application on isolated local service                                    |
| `COMPOSE_PROJECT_NAME=raui107 pnpm recovery:drill`    | PASS:encrypted restore,66 tables,18 migrations,10 sequences, PostGIS, scratch cleanup           |
| `pnpm smoke` against locally started built API/web    | PASS:web/API health, Postgres/PostGIS, Redis, categories, OpenAPI, protected admin              |
| `git diff --check`                                    | PASS                                                                                            |

Initial failures were investigated, not hidden:contract tests reproduced unsupported
modes, UI regression reproduced monthly guidance, and PostgreSQL HTTP withdrawal
reproduced missing lifecycle snapshots. Strict test typing, outdated test fixtures,
ESLint issues and a UUID-based test lookup were corrected before final passing runs.
The first recovery attempts used the default Compose project while services were
isolated as raui107; supplying COMPOSE_PROJECT_NAME fixed the setup without changing
recovery code. Missing host pg_dump was not the cause:the runner uses container tools.

## Evidence retained locally

Logs:`/tmp/raui107-{test,integration,build,lint,types,security,e2e,recovery,smoke}.log`.
Supplement:`/tmp/raui107-target-integration-final.log`.
Runner artifacts:`.cache/phase4d-{load,recovery,e2e-summary}.json` where generated.
Reports and implementation notes are tracked here and in ISSUE_107_SUBSCRIPTIONS.md.
Temporary logs are session-local; these tracked reports retain the outcomes.

## Acceptance limits and follow-ups

- No new remote CI run:push is prohibited. Historical CI194 is not evidence for
  this new candidate. Full new-SHA CI and submitted independent review remain gates.
- Local browser matrix used desktop and Android Chromium. Firefox/WebKit/iOS matrix,
  runtime image/archive acceptance and release artifact dry-run were not rerun here.
- No staging/production/VPS/WordPress changes or acceptance. Local production-build
  smoke is not live deployment certification. Issue104 release gates still apply.
- No real notification provider was enabled, and no real email/SMS was sent.
  Integration delivery uses an in-process local test transport only.
- The original dirty `/workspace/RAUI.RU` checkout was preserved; its porcelain
  status before/after matches. Only this separate checkout was written by root.
- No push, merge, deploy or new remote PR. No broad deletion or account cleanup.

Recommended next step:review the local candidate, then separately authorize push
for new-SHA CI and an independent submitted review. Release remains gated.
