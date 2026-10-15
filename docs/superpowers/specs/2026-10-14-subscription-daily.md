# Daily listing subscriptions: in-app release

Authority: RAUI_TZ_v1.1 notifications and the existing portal-workflow subscription contract. This incremental block implements daily **in-app** delivery. Daily email is explicitly unavailable; no delayed individual emails, aggregate transport, provider configuration or sends are introduced.

## Storage and release

Add migration 020; preserve 001–019 bytes. The canonical transactional listing producer additionally captures strict immutable daily candidates for users who selected daily/in_app and current consent. Candidates contain only the same neutral typed event envelope as immediate delivery. A user/day run holds a fixed cutoff and immutable candidate manifest. Each worker transaction processes at most 100 candidates; notifications remain hidden while the run is open, then an atomic run release exposes the completed manifest. This is an operational batch size, not a subscription quota.

Existing professional worker invokes the coordinator, with no new cron or service. Operational defaults are release hour 09:00, Europe/Moscow and candidate TTL 48 hours; validated environment configuration can override them. These are engineering defaults, not business requirements or delivery guarantees. DB wall-clock determines due slots and expiry after lock waits. A stopped worker catches up the latest due slot. Events after its cutoff wait for the next slot.

No high-water ID or timestamp cursor advances over uncommitted transactions. Only committed unassigned candidates are claimed; a candidate committed after a completed day's run remains unassigned for the next release, even when its sequence ID and timestamp are older. TTL is checked at claim/inbox insertion time after visibility waits, not the end of a multi-batch run or the lifetime of released history. Expiration before insertion gives an explicit skipped manifest item. No automatic history deletion is introduced.

## Authorization and provenance

Lock order: user FOR NO KEY UPDATE, subscriptions ordered by listing_id, run, candidates. This user lock is compatible with producer FK KEY SHARE. Preference writers already use the same user mutex. Final release is transactional with candidate assignment and notification insertion; restart/replay cannot expose a partial run or duplicate events. Candidate and manifest records reject updates/deletes. A released run cannot reopen or change cutoff/day/recipient.

Before creating an inbox item, require current active user, global in_app preference, current consent version, exact subscription version, daily frequency, selected event/channel and current full listing eligibility. Price events also match the current price; unavailable events expose no private listing fields. The existing reader repeats these gates. Captured frequency and exact released run + candidate/notification membership distinguish daily from legacy immediate rows; cross-user or missing provenance fails closed. Messages retain null subscription provenance. Raw inbox pagination continues scanning hidden rows. A cursor is a point-in-time traversal, not a live feed: refresh the first page after a release to discover newly visible rows whose IDs a previous traversal passed.

## UI and compatibility

Listing/account copy states that daily in-app is available, daily email is unavailable and immediate email still depends on configured transport. The API continues preserving existing explicit channel/frequency preferences. No REST shape changes are needed. Roll forward schema 020; rolling back reader code requires suppressing daily rows or using a reader compatible with 020. Stop producer/coordinator together before rollback; preserve manifests and candidates.

## Acceptance

Unit tests: release-slot boundaries/config validation, current-consent reader and manifest isolation. Real PostgreSQL: 019→020 preservation, repeated migration, late committed candidate, restart/open-run batching, concurrent coordinators, pre/post-release disable/frequency/global preference changes, expiry after lock wait and exact once release. Runtime/recovery contracts require 20 migrations. PostgreSQL acceptance runs in CI; this environment has no PostgreSQL/Docker. Daily email remains a separate future block requiring a durably committed immutable full transport envelope and whole-digest retry authorization.
