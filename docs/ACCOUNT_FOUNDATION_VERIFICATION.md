# Account foundation verification — 8 October2026

Scope: permanent numeric ID and administrator-issued staff capabilities, based on
Issue73 and today's consolidated account policy. Repository implementation is
separate from deployment. Two independent audits and a final source review found
no remaining blockers in this bounded scope.

## Implemented

- Migrations014 and015 preserve UUID relationships and existing application login.
- Registration/backfill assigns positive unique immutable numeric ID; API returns
  decimal string, account displays it, explicit projection excludes private fields.
- Administrator issues/revokes moderation.read and moderation.decide with reason
  and audit. No default grants; other admin operations remain administrator-only.
- Existing pending moderation supports scoped text/property and protected image
  reads. Pending case, listing/media identity, version and ready variants checked.
- /admin/staff provides paginated user selection and grant/revoke controls through
  narrowly allowed browser proxy routes.

## Local evidence

Passed lint, typecheck, full pnpm test, build, security scan/dependency audit and
observability rules. Real PostgreSQL/HTTP integration:98 tests,0 failures,
including populated master upgrade, unchanged existing facts, checksums, repeat
migrations, numeric IDs and permission boundaries. Production-built API/web and
separate media worker passed pnpm smoke and smoke:core. Recovery drill restored a
populated encrypted fixture and verified15 migrations plus sequence identity.

New tests were observed failing for missing behavior before implementation and
passing afterward. Permission cases include default denial, read/decide isolation,
self-escalation denial, revoked/inactive/unverified staff, no self-moderation,
unchanged ownership rules, closed-case materials and private image access.

Local browser installation was blocked by403 Domain forbidden from
cdn.playwright.dev. Browser E2E and complete immutable-head release artifact
checks therefore require GitHub CI; record final CI result in the PR. No local
browser-pass claim is made here.

## Rollout boundaries

No remote deployment or production migration performed. This environment has no
configured staging SSH host/user/key or SSH agent; the existing readiness workflow
is a dry-run and never installs a release. Passing checks alone do not establish
the running staging SHA.

Keep additive schema/IDs on rollback. Do not reset or reuse the numeric sequence.
This milestone performs no real-message dispatch, destructive retention cleanup,
SMS policy switch or automatic access approval. Next: moderator workbench and
reasoned blocks/complaints; then accepted SMS approval flows; then controlled
retention and tariff jobs. AI assistance remains advisory until its provider and
quality/privateness/cost checks are accepted.
