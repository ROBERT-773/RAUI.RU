# Subscription availability visibility revisions

**Status: proposed groundwork; not implemented.** Authority: `RAUI_TZ_v1.1.md`, the portal workflow's latest-current-state decision and the existing neutral availability contract. This block prevents an old availability event becoming eligible again after a dependency hides, restores and hides a listing without changing its listing version. It does not create notifications for global account/organization/membership changes.

## Scope and alternatives

Keep the current listing version and public-price baseline. Artificially incrementing every affected listing version couples account actions to publication/edit concurrency and requires unbounded fanout. Independent counters on membership rows can reset after deletion/recreation. Use one **consumed** visibility-generation registry, read by the authoritative availability gate; no unused source-intent/outbox table is introduced.

Registry entries have an immutable server-built dependency key and a nonnegative bigint generation. Existing user, organization and membership keys are seeded with `0` during the additive migration. A noncycling sequence supplies fresh positive generations for inserts and relevant changes; rollback gaps are harmless and sequence values are never a commit-order cursor. Registry deletion and identity changes are forbidden, generation updates must increase, and removed memberships retain their registry entry. Successful membership deletion advances that entry. No entity foreign-key cascade may erase it.

Triggers update only the changed entity's registry key. The generation vector tracks the actual public predicate, not unrelated profile fields:

| Dependency                                      | Changes that advance its generation                                                                | Existing writers covered                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Seller                                          | `active`; email/phone verification NULL/non-NULL state; membership in the eligible seller-role set | `Admin.user`, `Auth.confirm`, `PhoneOtp.confirm`, `bootstrap-admin`    |
| Organization                                    | `active`                                                                                           | `Admin.organization`                                                   |
| Membership identity `(organization_id,user_id)` | insert/delete, or `active` change                                                                  | `Organizations.setMember` upsert/offboarding; direct SQL insert/delete |

Owner→agent or admin→member changes do not change public eligibility by themselves; membership role, registration approval state, source activation, password, display name and a changed non-NULL verification timestamp do not advance these generations. Compare component booleans independently: verifying email advances even if phone is still unverified. This is invalidation metadata, not evidence that a listing was publicly visible. Registry keys contain dependency UUIDs, no contacts or listing text.

## Atomic state and typed token

Extend the existing authoritative neutral visibility query to return `{version, visible, visibilityToken}` in **one SQL statement/snapshot** using the existing full public predicate. Do not read a token and then query visibility separately. The token is strict and server-owned:

- `seller: {id: UUID, generation: DecimalGeneration}`;
- `organization: null | {id: UUID, generation: DecimalGeneration}`;
- `membership: null | {organizationId: UUID, userId: UUID, generation: DecimalGeneration}`.

`DecimalGeneration` is canonical nonnegative decimal text within PostgreSQL bigint range, preserving exactness; no JavaScript-number coercion. Direct listings require both organization and membership null. Organization listings require identities matching the current listing/seller. A deleted, previously known membership still has its registry generation. A missing/malformed registry entry for a required dependency makes the token invalid and suppresses availability; never coalesce unknown data to legacy generation zero. An organization listing whose membership was never recorded cannot manufacture availability evidence from missing metadata. The normal public predicate still evaluates independently.

## Envelope and consumers

Keep strict existing price-drop payloads and their full-visibility/current-price gate unchanged. Add a separate strict availability envelope with `schemaVersion: 2`, existing listing/subscription versions, the typed `visibilityToken`, and exactly `{kind:'availability', available:boolean}`. Reject extra/unknown fields, unknown schemas, mismatched dependency identities and noncanonical generations. No private title, price, description or visibility reason enters the neutral availability snapshot/envelope.

The canonical lifecycle producer obtains the post-change neutral snapshot in its existing SQL transaction, checks the expected listing version/current availability and emits v2 availability. Its deterministic availability dedupe key includes listing ID/version and the canonical ordered token components, so dependency state identity is not reduced to listing version. Retry/replay uses the same key; no random dedupe suffix. Price keys and public-price snapshot capture/read remain unchanged. No extra price-drop event is created for a dependency-only change.

The shared `eligibleListingSubscriptionEvent` checks availability boolean, listing version and exact token against that single current snapshot. Both available and unavailable branches use this neutral projection. Existing immediate email, immediate inbox, daily candidate preparation and daily inbox reads all use this shared gate; their strict parsing sites must accept the versioned union without stripping the token. Exact daily manifest/envelope comparisons remain intact.

Legacy availability envelopes without a token are accepted only when every required dependency has a known registry generation of zero and the original current-state/version gate passes. Once any generation advances, legacy envelopes fail closed permanently, even if the public boolean returns to its old value. Fresh post-migration fixtures/producers must use v2 rather than disabling triggers or manufacturing zero generations. Legacy price-drop and message behavior is unchanged.

## Transactions, rollout and limits

Capture/invalidate generations in the source transaction; rollback leaves prior state/generation together. Do not enqueue subscriber deliveries from these triggers. Existing source locks precede their own registry-key update; registry reads add no locks and no new parent user/org lock is acquired from a membership trigger. Preserve creator-user→organization→membership→client authentication and organization→membership→client offboarding order. Never call the existing subscription-locking producer while holding a global user `FOR UPDATE`: it can cycle with recipient user→subscription locks and notification FK `KEY SHARE`. A later source-evidence/fanout design must address that separately.

Use the next unapplied additive migration after 020; reserve its filename only at implementation dispatch. Preserve 001–020 bytes and current data. Before the seed snapshot, acquire write-blocking table locks on users → organizations → memberships in that deterministic order (SHARE ROW EXCLUSIVE or a proven stronger compatible mode), then seed and install triggers in the same migration transaction. A transaction alone does not close the seed/trigger gap: an ACCESS SHARE seed SELECT permits a concurrent update before CREATE TRIGGER acquires its lock. Bound lock acquisition using the existing migration timeout and prove the ordering with real PostgreSQL writer barriers. Roll forward; do not remove registry rows or reset generations. A rollback reader/sender must understand v2 and the legacy-zero restriction, or suppress **all availability** in producer, worker, daily coordinator and inbox reader. Stopping only new production or allowing an old reader is unsafe: legacy rows can revive. Price-drop/message behavior need not be disabled. New migration/runtime/recovery contract counts advance together only during implementation.

**Not delivered by this block:** global availability event sources/fanout, historical transition reconstruction, daily email aggregation, provider configuration or sends. Correct global event generation needs transactional evidence of actual full-public-before state; neither current state, a source intent alone nor last-public-price history proves it. Synchronously capturing every affected listing may be unbounded; do not invent a quota or silently truncate it.

## Required evidence

Unit and real PostgreSQL acceptance must prove exact token parsing, generation no-ops/changes and rollback, same-version hide/show/hide rejection, legacy zero compatibility then permanent invalidation, missing/corrupt current registry failure, member deletion/recreation without ABA, neutral projection privacy, producer replay and all four existing delivery/read paths. PostgreSQL tests must use actual trigger writes and locks; no claimed acceptance from compilation alone. No merge/deploy or real-provider sends are authorized by this groundwork.
