# Owner and publication review workflows: verification

## Delivered

- /account/listings: explicit Moscow/MO property and offer creation with configured typed category fields and manual coordinates; persisted listing drafts; versioned price/title/description changes; pausing published offers; JPEG/PNG/WebP upload and processing state; explicit submission through processing into manual moderation; last publication rejection reason.
- /admin/moderation: pending cases, matching listing versions, protected photographs, safe known scalar characteristics, reason and explicit decision confirmation, retry keys and refresh. Text helper gives advisory hints only.
- Account navigation link, optional idempotency key in CSRF-aware client, narrow proxy allowlist. Existing API authorization remains authoritative.
- Test runner starts a tracked media worker and seeds isolated verified admin/unverified seller fixtures. No database migration or production configuration changes.

## Evidence

Final product code passed pnpm lint, pnpm typecheck, pnpm test and pnpm build. Tests: web82, API84 plus script39, UI1, Python5; zero failures. pnpm test:e2e with CHROMIUM_EXECUTABLE=/usr/bin/chromium passed all26 desktop/Android Chromium cases, including real draft→PNG processing→moderation→staff approval→public detail. Browser suite also checks guest/unverified denial, persisted drafts after reload, existing search/account/message/accessibility/security journeys. Temporary DB/index and API/web/media worker cleanup passed.

The browser harness measured six critical read scenarios, 240 requests at concurrency4, p95<=300ms. Built-service pnpm smoke against the isolated E2E API/web passed health, PostgreSQL/PostGIS, Redis, migrated categories, OpenAPI and protected admin checks. This is local evidence, not a staging/production performance promise.

Independent review identified concurrent creation overwriting edits; fixed using child creation state to lock the existing editor/navigation/actions. A delayed-final-POST regression was observed failing before the fix and passing afterward. File length/MIME mismatches now reject before upload, leaving the chooser available. No further blockers found in the bounded scope.

Initial runs were not green: the runner rejected the newly introduced worker label, and two browser locators were too broad/exact for actual accessible labels. Added worker lifecycle regression and corrected browser selectors; the complete rerun passed. Tests were not disabled.

Full five-browser GitHub CI and existing integration/recovery/release gates are checked separately on the pushed candidate SHA; do not infer their result from local Chromium. No merge or deployment performed.

## Remaining scope and rollout

The full scenario is docs/RAUI_ACCOUNT_SCENARIO_2026_10_08.md. Latest user instruction selects six months of exclusion and indicative three-day/free and one-day/paid moderation targets. This change does not enforce those rules.

Still required before claiming the full public launch: verified provider-backed SMS/approval recovery flow; six-object quota; ownership evidence and three-day agent conversion; paid entitlements and renewal; complaints/post-publication blocks; automatic cleanup/account deletion; ESIA/social login; CRM/Pro/agency experience; tariffs/bidding; booking, insurance and electronic transactions.

Creation retry keys and partial property recovery survive retries within the current mounted page, not a browser reload. Autosave, address autocomplete/map correction, offer terms editor and media removal/reprocessing remain follow-ups. A failed processed image blocks submission under current API rules. Category and property editing after creation are not exposed here. No real SMS/email, charges or destructive account jobs were triggered.

Rollback: revert the web/UI/proxy changes and test-runner changes; existing stored properties/listing drafts remain valid in the pre-existing API schema. Do not delete user data as part of application rollback.
