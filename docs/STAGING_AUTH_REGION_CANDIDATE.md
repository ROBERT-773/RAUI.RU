# Staging authentication and regional search candidate

This integration branch combines prepared changes for one reviewable candidate.
It does not merge the source PRs into master or deploy to staging.

## Scope and provenance

- Session recovery and regional search: PR #69, `678ffb8`, including #66/#68.
- Password recovery pages: PR #51, `1ade120`.
- Reset-request privacy and opt-in SMTP: PR #61, `2aa3610`, including #53.
- Runtime container packaging in #62 and independent search changes #54–56/#59
  are not included. This candidate does not certify those branches.

The product scope remains Moscow and Moscow Oblast. Incoming Yandex mail is
already restored; this candidate changes neither MX nor any provider account.

## Integration plan and acceptance

1. Combine the exact source commits on a dedicated branch, preserving both
   regional catalogue copying and SMTP test discovery in the API scripts.
2. Resolve shared auth imports without changing either the CSRF or reset privacy
   contract. Remove duplicate test imports introduced by automatic merging.
3. Exercise the combined browser client: a cookie session in a new tab permits
   search and logout; anonymous recovery reaches the real API; an invalid reset
   fragment is removed and cannot be submitted. The unknown-email fixture never
   sends a real message. Existing integration tests cover successful reset,
   token consumption, session revocation and delivery outages.
4. Run frozen installation, lint, typecheck, unit tests, build, integration,
   browser E2E, migration/recovery checks and built smoke against isolated local
   services. Record final CI identity in the PR after it completes.
5. Prepare a PR for review. Actual deployment and provider acceptance remain
   separate operations under Issues #40/#41.

## Configuration and rollout limits

Deploy matching API and web artifacts from the same verified commit. Apply
additive migration 013 before regional API readers start, and reconcile the
search index as described in `REGIONAL_SEARCH.md`. Retain migration 012 and
existing security controls.

SMTP remains disabled by default. Enabling it requires secure configuration and
a clean HTTPS WEB_ORIGIN. Gateway priority, verified TLS, AUTH LOGIN, the total
five-second SMTP deadline and reset response privacy remain unchanged. Never
place credentials in Git, chat or evidence. Production still requires the
approved HTTPS verification gateway; SMTP is not a substitute for that gate.

Full details: `PASSWORD_RESET_SMTP.md`, `PASSWORD_RESET_API_PRIVACY.md`,
`EMAIL_PASSWORD_RECOVERY.md` and `SESSION_CSRF_RECOVERY.md`.

## Rollback and remaining acceptance

Keep a verified previous API/web/config pair. Disable SMTP before switching away
from this candidate; do not drop additive schema columns or restore old data as
an application rollback. A rollback artifact must retain the accepted security
baseline. Old web loses cross-tab CSRF recovery; new web requires the recovery
API endpoint.

No live email, staging or production deployment is performed here. Staging still
needs its deployed SHA/configuration, correct public origin and private ingress,
real login/search/logout and reset-email inbox evidence. Passing local/CI checks
does not establish the cause of the user's specific staging 403.
