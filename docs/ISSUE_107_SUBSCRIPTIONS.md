# Issue107 — listing delivery and audit corrections

Scope: local fixes on PR98 head `77039fab34f9b6f34c4d2e7d20f899880dd23aa8`.
No production changes, real notification activation, push, merge or deployment.

## Supported contract

The subscription API and form support **email / immediate** only. Creating a
subscription requires `version: 0`; updating or explicitly resuming requires
its current version. GET `/v1/account/listing-subscriptions/:id` returns the
current account's version, including a disabled row. Another account sees its
own version (zero when absent). Stale writes return409. Disable still requires
the current positive version. Reopening the form reloads the version and requires
an explicit new consent choice; a conflict never silently retries or resumes.

Existing daily/in_app preferences are retained as data, but never represented
as working delivery. Their account panel explains the limitation and permits
unsubscribe or an explicit switch to supported preferences on a public listing.

## Authoritative events and transaction boundaries

Audit.history is the shared transactional listing-history boundary. Valid
before/after snapshots include status, price and version. Public eligibility
uses the same seller/organization policy as public listing access. Lifecycle
and moderation callers now provide those snapshots, including agency bulk pause.
The history record and matching immediate email outbox insertion commit or roll
back together. Stable listing/version/event dedupe keys prevent repeated enqueue.
Draft/private price changes do not create price notifications. Availability
loss contains only the unavailable event, without price or private object data.
Public-to-public price reductions generate price_drop; the existing editor still
requires pause/edit/re-moderation, whose lifecycle emits availability instead.
This task does not change that publication policy.

The worker revalidates current subscription version, enabled state, selected
event/channel/frequency and exact consent_version before transport. Recipient,
global preferences, seller, listing and organization membership eligibility rows
remain locked through the bounded transport operation. Subscribe/disable and
worker share a transaction advisory lock for the account/listing pair.
A completed unsubscribe blocks a subsequently started send. If transport already
owns that lock, the unsubscribe waits for send completion (or fails its bounded
lock wait and must be retried); successful unsubscribe does not recall an email
already accepted by a provider. Finalization uses the same database transaction,
so concurrent deliveries do not require an extra connection while holding locks.
Gateway idempotency keys remain required for retries after process/commit failure.

No migration is added or edited. The complete001–018 ledger remains required.
Never mix this worker/API with older subscription producers/consumers: the older
API can re-enable stale preferences and the older worker lacks these checks.
Keep compatible workers or use a reviewed forward fix, retaining queue and
history data. See RELEASE_ROLLBACK.md for pending/running/dead queue gates.

## Quota guidance

Owners retain one simultaneously published listing and three genuine
publications per Europe/Moscow calendar month. The own-account endpoint now
returns monthlyLimit, monthlyPublications, monthlyRemaining and monthlyResetAt,
using one database snapshot. Professional roles receive null quota fields.
The panel distinguishes active-slot release from monthly exhaustion; pausing
does not reset monthly usage. Draft creation remains available.

## Explicit follow-ups — not delivery promises

- Daily email digest: implement a transactional aggregation window, dedupe,
  cancellation/revalidation and acceptance tests before adding API/UI choices.
- In-app listing updates: implement authoritative event fan-out, privacy checks,
  account notification rendering/read states and tests before adding choices.
- Provider acceptance: separately authorize/configure a real gateway and verify
  delivery, templates, rate limits and unsubscribe behavior. Local test adapters
  and queued events are not evidence of actual email delivery.
- Release: new-SHA CI including full browser/runtime image matrices, independent
  submitted review, staging migration/recovery and provider gates from Issue104.
  No push was authorized, so remote CI/review cannot be claimed for these fixes.

## Verification evidence

See ISSUE_107_VERIFICATION.md for final commands/results and local commit.
