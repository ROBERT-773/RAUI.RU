# Authenticated phone OTP verification

Implementation: `feat/phone-otp-verification`, Issue82. Final checks are recorded below; CI provenance is updated on the PR at its
immutable implementation commit.

## Result and boundaries

An authenticated active pending or approved account can request and confirm a
six-digit phone code when numeric OTP is configured. This verifies its phone only:
registration approval, role, activation and email remain independent. The profile
uses capability discovery and preserves the legacy long-token path when disabled.
Phone signup and sign-in have a separate pre-session flow. The
`PHONE_SIGN_IN_ENABLED` flag defaults to false and requires the existing numeric
OTP gateway configuration. Account recovery by SMS and external identity
providers remain separate work. Real handset delivery remains a separate
staging acceptance check.

### SMS sign-in and registration design

- Use the existing delivery adapter, with a separate pre-session challenge
  bound to the initiating browser, destination and sign-in purpose.
  Verification challenges issued in the cabinet cannot create a session.
  The request response must have the same shape for new, existing and
  ineligible accounts. Apply per-IP and destination limits, sharing the
  destination send budget with existing verification. Allocate once per
  idempotency key and keep delivery outside the database transaction.
- Use a short lifetime and limited attempts. Under locks, consume a valid
  code once and recheck the current account and verified number before
  issuing the normal session. Staff retain the password and second-factor
  flow. A disabled or rejected account cannot sign in or start a replacement
  registration with the same number.
- A new number yields a short-lived, one-time registration continuation.
  After SMS, collect role, name, email and password. The last two fields
  remain required by the existing user schema. Consume the continuation and
  reserve the unique number in the same transaction as account creation.
  Keep email confirmation and registration approval independent.
- Acceptance covers existing and new accounts, replay and throttling,
  concurrent registration, revoked eligibility, and the desktop and mobile
  journey through the cabinet. Confirm handset delivery separately on the
  isolated release candidate using the approved staging drill.

Migration017 adds challenge and send-event tables without changing001–016. Codes
are HMAC-protected with an independent pepper, never persisted as plaintext. Five
wrong attempts commit and exhaust the challenge; codes expire after five minutes.
User/destination send limits, one-minute cooldown and hourly budgets include legacy
phone requests while OTP is enabled. Idempotent replay allocates and sends once;
an unknown/crashed dispatch is never automatically retried.

## Review and evidence

Independent backend review found and resolved legacy cross-user lock inversion and
idempotency-key contract drift, user/session FK lock compatibility, and session
expiry after lock waits. Contract/UI tests observed red then green. Initial
backend implementation did not follow test-first order; tests and independent
review verify behavior, but this work does not claim universal TDD compliance.

A captured delivery adapter drives real HTTP/PostgreSQL integration checks.
Configured-adapter unit checks intercept native DNS/HTTPS boundaries, exercising
request options, body, response handling and timeout without sending a real SMS.
These tests establish adapter behavior, not provider delivery or external TLS
connectivity. Local browser regression uses disabled OTP; numeric entry is covered
by component tests and server integration, not a live-provider browser journey.

## Local verification (8 October2026)

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: passed.
- Unit results:164 web,110 API,39 runtime/recovery scripts,1 shared UI and5 Python.
- Focused final real HTTP/PostgreSQL OTP acceptance:20 passed, including logout
  audit concurrency and session expiry after a session-only lock wait.
- `pnpm test:integration`:140 passed before the two final lock regressions were
  added; the final OTP suite separately passed20. The first full run stopped on
  the old OpenAPI idempotency-operation inventory; the new required-header route
  was added while retaining all contract assertions. Exact-head CI runs the full
  final142-test integration set. Its status is reported on the implementation PR.
- `CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e`:28 desktop/Android tests
  passed; six read-load scenarios,240 requests,concurrency4,p95 within300ms.
- `pnpm db:migrate` repeated: passed. `pnpm recovery:drill`: encrypted populated
  restore passed with17 migrations and scratch cleanup.
- Production-built `pnpm smoke`, `pnpm smoke:core`, commerce/professional/trust
  worker one-shots, search reconciliation and `pnpm smoke:search`: passed.
- `pnpm observability:check`, `pnpm security:check`: passed; dependency audit
  reported no known vulnerabilities.
- Independent security and whole-feature review: no remaining blocker. The
  malformed inherited delivery-key UI guard was fixed with an enum regression test.

## External enablement

The default is `PHONE_OTP_ENABLED=false`. Enable only with secure bindings for
`PHONE_OTP_PEPPER`, `PHONE_OTP_GATEWAY_URL`, `PHONE_OTP_GATEWAY_TOKEN`, and a gateway
implementing the strict version1 matching202 acknowledgment contract. Operational
checks include sender/template, Russian coverage, billing limits and a separately
authorized controlled recipient. No secrets belong in chat, Git or browser code.
Gateway acceptance is explicitly distinct from confirmed delivery.

## Rollback and retention

Disable `PHONE_OTP_ENABLED` and retain migration017/tables. Old long-token routes
remain available. Preserve registration approval guards during binary rollback.
Pepper rotation invalidates outstanding codes and destination quota digests:
disable new phone sends for the full one-hour quota window before rotating.
Send events are queried by rolling timestamps; automated retention cleanup is
deferred and is not needed for quota correctness. No real SMS, merge or deployment
is performed by this implementation task.
