# Phase 4B — Professional Tooling, Feeds and Partner Integrations

## Scope

Implement:

- agency/developer organization tooling;
- portfolio and bulk listing operations;
- developer hierarchy;
- feed definitions and scheduled imports;
- validation and dry-run mode;
- upsert/idempotent reprocessing;
- source tracking and quarantine;
- import logs/metrics;
- partner API keys, scopes and rate limits;
- notification delivery adapters/retries/preferences;
- admin controls for feeds/integrations.

Preserve Property/Listing/ListingSource as the core model.

## Required tests

- feed validation/import/upsert/idempotency;
- source traceability;
- partner API authorization/rate limits;
- bulk operations permissions;
- notification retry/dedup/preferences;
- admin audit coverage.

Run full standard CI plus integration/smoke checks.

## Exit criteria

- professional workflows map cleanly into the existing core model;
- feeds are traceable and safely reprocessable;
- partner API permissions are scoped;
- notification delivery is retryable and idempotent;
- branch/PR/report complete and checks green.

After merge, continue with `docs/PHASE4C_AI_TRUST_SPEC.md`.
