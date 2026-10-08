# Registration onboarding implementation

This deliverable follows the newest account scenario and preserves the separately agreed staff approval requirement. Launch geography remains Moscow and Moscow Oblast.

## Implemented

- Buyer/owner signup choice; immutable numeric ID remains informational.
- New registrations create a pending request atomically. Existing users remain approved through migration016.
- Pending cookie and bearer sessions permit only profile, contact verification, CSRF bootstrap, session management and logout. Business operations and staff actions remain forbidden.
- Contact panel uses the existing verification gateway and long-token contract. It requests confirmation and refreshes persisted contact status, without claiming message arrival or numeric SMS support.
- Scoped registration.read/registration.decide queue, contact evidence and reasoned decisions. No default delegation; listing moderation permission does not grant registration access.
- Fresh staff identity/session/permission checks before idempotency replay; locked applicant/request, active verified applicant for approval, self-review denial, audit and rejection session revocation.
- Known email-provider failure after account creation returns created account with verificationDelivery=unavailable. Other failures still propagate; password-reset privacy behavior is unchanged.
- Expired/revoked-session401 clears private UI;403/503 retain the session and error. Identity epochs protect another account from late replies.
- Narrow proxy routes, strict OpenAPI decision schema and16-migration release/recovery compatibility.

## Verification

Mandatory lint, typecheck, full unit tests and build passed. Final web suite119; API92 plus script39; UI1; Python5. Isolated PostgreSQL/PostGIS/HTTP integration106 checks passed, including populated migration upgrade, pending cookie/bearer denial, independent contact/approval requirements, scoped permissions, concurrent decisions, replay after revocation, self-review, inactive/unverified denial and rejection.

Encrypted recovery drill passed with16 migrations and scratch cleanup. Built web/API smoke, observability check and credential/TLS/client-boundary scan passed; dependency audit found no known vulnerabilities. Final browser and exact-head CI evidence are recorded in the PR separately.

Final local real-browser run passed all28 desktop/Android Chromium cases, including new owner registration, pending private-route denial, contact request acceptance, independent staff rejection, profile session expiry and expired logout. Existing publication/search/map/messaging/recovery flows passed. Six read-load scenarios passed240 measured requests at concurrency4 and p95<=300ms. Runner database/index/files/process cleanup passed. An initial browser run failed an exact-label locator for the account-type selector; corrected the accessible selector and reran the complete suite without disabling tests.

Initial integration runs correctly failed historical hardcoded15-migration and idempotent-operation expectations. Updated explicit expectations and checksum/schema-preservation checks; the complete rerun passed. Independent review found stale authenticated UI after rejection; reproduced with failing tests and fixed. Some agent UI test-first execution was initially blocked by the system pnpm launcher; no observed red-first claim is made for those tests.

The first exact-head CI run37757347731 failed its Production smoke step after the browser suite passed. Reproduced locally: the historical core smoke attempted property creation for a newly registered, verified but still pending owner and received403. Corrected only the local smoke fixture: a separate trusted synthetic administrator approves real registered applicants through the audited registration API before domain actions. The existing operator bootstrap remains unchanged and its session revocation is asserted. Local-only adapter/database guards remain in place; no production authorization bypass was added.

The corrected built-service core smoke passed registration, verification, staff approval, operator bootstrap, property/listing creation, separate media-worker processing, moderation, public media and session revocation. Commerce/professional/trust worker one-shot runs, search reconciliation and built search/map/selection/SSR smoke also passed. An intermediate repeated smoke run hit the existing shared auth rate limit; the rerun waited for the normal window without disabling or clearing limits. Lint, typecheck, full unit tests and build passed again. Updated exact-head CI evidence belongs in the PR; the initial failed run is not reported as successful.

## Limits

No real email/SMS was dispatched. Live verification gateway acceptance, numeric SMS/call codes, phone-first registration/login, ESIA/social/Sber and recovery approval remain separate work. The existing email password-reset flow remains functional and does not yet require staff approval.

Rejected accounts cannot log in; rejection revokes sessions. Their decision reason is stored for staff, but delivering that reason to a rejected applicant requires a separate safe notification/support contract. The UI can show persisted reasons to readable accounts; it does not promise rejected users can access a closed cabinet.

The queue is an in-portal notification, not push/email delivery. Quotas, paid entitlements, ownership proof, automatic agent conversion, retention, account deletion and six-month re-registration exclusion are not enabled by this change. No merge or staging/production deployment performed.

## Rollout and rollback

Migration016 is additive and preserves prior accounts; retain it after rollback. Apply and verify it before switching the API. Do not mix old registration/API binaries with the new approval policy: old binaries ignore approval state and create default-approved accounts. Pause signup during any coordinated transition that would route traffic to old binaries.

Prefer a forward fix retaining the new authorization guard. Reverting to an older API while active pending/rejected accounts exist bypasses the approval policy. An operational rollback would require pausing signup, deactivating all non-approved accounts and revoking their sessions before old API traffic, with a separately reviewed restoration/reactivation procedure. These are deployment instructions, not actions performed here. Never drop user data or migration016 as application rollback.
