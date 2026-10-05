Phase 4C adds default-off AI advisory foundations, auditable duplicate/fraud review and privacy-safe analytics on the merged Phase 4B baseline. Property facts, publication and physical identities stay authoritative in the existing modules; model suggestions cannot write or merge domain records.

Closes #25.

Implemented:

- Ten provider-agnostic capabilities with deterministic fallbacks, human confirmation, kill switches, bounded timeout/retry/cost reservation, stable gateway idempotency and sanitized metrics.
- HTTPS/DNS-pinned gateway adapter with strict output bounds and decoded-token reflection rejection.
- Python multi-signal duplicate scoring, durable leased trust worker with bounded retry/dead-letter/fair scheduling, immutable evidence and stale-snapshot-safe independent admin review; AI-off enforcement in the existing moderation approval route.
- Versioned analytics events, conflict-safe cross-day replay, daily pseudonyms and retention, seller aggregates, minimum live-public market cohorts and indicative valuation.
- Additive migrations 009/010, OpenAPI/env/operations documentation and Phase4C report. Existing security assertions and CI gates remain enabled.

Validation and limitations are recorded in docs/PHASE4C_REPORT.md. Local lint/typecheck/unit/integration/build, repeat migrations, built-service smoke, professional/trust workers and Chromium desktop/mobile E2E are required before final handoff. Full CI browser matrix remains enabled; local Playwright CDN downloads are blocked by the cloud network policy. No live provider credentials were used and AI stays off by default.

No merge, production deployment or Phase4D work. Forward fixes retain applied SQL and immutable evidence; rollout/acceptance requires the owner gate.
