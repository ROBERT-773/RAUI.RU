# RAUI.RU — Provider Acceptance Matrix

Purpose: track non-production provider readiness for RAU-13 and the production launch gate. Record provider names, endpoints/classes, status and evidence links only. Never store secret values, tokens, passwords, private keys or full connection strings here.

## Guardrails

- All credentials must be injected outside Git/chat/logs.
- Use sandbox/staging accounts only.
- Keep risky integrations disabled until their acceptance row is complete.
- Preserve fail-closed behavior.
- Do not enable production flags or perform production calls.
- A provider is not accepted because a local stub/fallback works.

## Acceptance matrix

Current launch-scope matrix:

- Verification email/SMS — binding: `VERIFICATION_GATEWAY_URL` plus secure token; source behavior: local delivery/storage is prohibited in production; required acceptance: provider send/verify plus timeout/invalid/retry; state: BLOCKED.
- Notifications — binding: HTTPS gateway plus bearer token; source behavior: HTTPS-only, DNS/public-IP validation, pinned address, SNI preserved, stable Idempotency-Key, 5s timeout, bounded retry/DLQ, and unconfigured means defer; required acceptance: delivered event plus timeout/retry/DLQ/replay; state: BLOCKED.
- Feed imports — binding: allowlisted HTTPS hosts; source behavior: empty allowlist denies fetch; required acceptance: allowed feed fetch plus blocked-host/SSRF/redirect tests; state: BLOCKED.
- Private object storage — binding: S3-compatible private bucket plus SDK credential chain; source behavior: local driver is non-production only; required acceptance: upload/read/delete plus permission/network/version-restore tests; state: BLOCKED.
- CDN/media delivery — binding: private origin plus intended CDN policy; source behavior: adapter-based; required acceptance: public delivery plus origin-bypass denial; state: BLOCKED.
- Maps tiles — binding: tile URL plus legal attribution; source behavior: optional frontend binding; required acceptance: render/attribution plus provider-unavailable fallback; state: BLOCKED.
- Geocoding — binding: HTTPS endpoint plus token; source behavior: optional with manual-coordinate fallback; required acceptance: address resolution plus timeout/invalid/manual fallback; state: BLOCKED.
- AI gateway — binding: gateway URL/token if enabled; source behavior: `AI_ENABLED=false` by default with per-capability flags and budgets/fallbacks; required acceptance: sandbox capability plus timeout/budget/fallback/non-authoritative behavior; state: DISABLED/BLOCKED.
- Payments — binding: selected provider adapter plus sandbox credentials; source behavior: unconfigured provider fails closed; required acceptance: create/refund/reconcile plus signature/replay/idempotency/failure; state: DISABLED/BLOCKED.

## 1. Verification provider

- Provider:
- Sandbox account/reference:
- Endpoint hostname:
- Credential injection mechanism:
- Sender identity:
- Test recipient policy:
- Evidence:

Acceptance:

- [ ] Endpoint is HTTPS.
- [ ] Token/credential exists only in protected staging settings.
- [ ] Send + verification flow succeeds.
- [ ] Invalid/expired/replayed verification fails safely.
- [ ] Provider timeout/error does not leak secrets or break auth invariants.

## 2. Notification gateway

- Provider/gateway:
- Endpoint hostname:
- Credential injection mechanism:
- Supported channels:
- Evidence:

Acceptance:

- [ ] Endpoint is HTTPS/443 and hostname-based.
- [ ] DNS resolves to public permitted destinations only.
- [ ] TLS verification/SNI remains correct while transport is pinned.
- [ ] Stable idempotency key is observed on retry.
- [ ] Timeout/retry/DLQ path is demonstrated.
- [ ] Unconfigured gateway defers rather than silently sends elsewhere.

## 3. Feed providers

- Approved hosts:
- Authentication mechanism:
- Sample non-production feed:
- Evidence:

Acceptance:

- [ ] Only explicit allowlisted hosts are fetchable.
- [ ] Redirects cannot escape the allowlist/public-IP policy.
- [ ] Private/link-local/loopback/reserved destinations are rejected.
- [ ] Import replay/idempotency and integration logs are verified.

## 4. Object storage

- Provider:
- Bucket/container:
- Region:
- Private access mode:
- Versioning:
- Encryption:
- Credential mechanism:
- Evidence:

Acceptance:

- [ ] Bucket is private.
- [ ] Workload uses SDK/IAM chain or equivalent protected injection.
- [ ] Upload/read/delete through application adapter works.
- [ ] Local filesystem driver is not used in staging/production mode.
- [ ] Version restore/recovery path is available for RAU-14.

## 5. Maps and geocoding

### Maps

- Provider:
- Tile URL class:
- Attribution:
- Evidence:

### Geocoding

- Provider:
- Endpoint hostname:
- Credential mechanism:
- Evidence:

Acceptance:

- [ ] Legal attribution is displayed.
- [ ] Geocoder uses HTTPS.
- [ ] Normal address lookup succeeds.
- [ ] Timeout/provider failure preserves manual-coordinate fallback.
- [ ] No credential reaches the browser unless explicitly designed as a public provider key.

## 6. AI provider

- Provider:
- Gateway:
- Enabled capabilities:
- Budget/cost limits:
- Evidence:

Acceptance:

- [ ] Global and per-capability flags remain off until accepted.
- [ ] Timeouts/retries/fallbacks verified.
- [ ] Per-call/daily budgets enforced.
- [ ] Uncertain/failed provider calls are not falsely recorded as actual spend.
- [ ] AI output is never authoritative for critical property facts.
- [ ] Provider failure preserves deterministic fallback.

## 7. Payments

Launch decision:

- [ ] Payments excluded from initial launch.
- [ ] Payments included; provider below is fully accepted.

If included:

- Provider:
- Sandbox merchant/account reference:
- Adapter implementation reference:
- Credential injection:
- Webhook endpoint:
- Evidence:

Acceptance:

- [ ] Create/payment intent is idempotent.
- [ ] Webhook signature validation passes/fails correctly.
- [ ] Replay protection works.
- [ ] Reconciliation is demonstrated.
- [ ] Refund flow is demonstrated.
- [ ] Provider/network failure remains fail-closed.
- [ ] Kill switch/default-off behavior verified.

## 8. Final RAU-13 acceptance

- [ ] Every launch-scope provider has a named sandbox/staging account.
- [ ] Required credentials are present only in protected environment settings.
- [ ] No secret values are present in Git, Linear, docs, artifacts or logs.
- [ ] Success + failure/degradation tests have evidence.
- [ ] Disabled providers are explicitly recorded as disabled.
- [ ] Payments launch scope has an explicit decision.
- [ ] Evidence is ready for RAU-18 reconciliation.

Final status: **INCOMPLETE until every provider in launch scope has real sandbox/staging evidence.**
