# Phase 4C — AI, Duplicate Detection, Moderation and Analytics

## Scope

Implement provider-agnostic, feature-flagged AI foundations:

- natural-language search interpretation;
- AI realtor assistant foundation;
- description generation;
- moderation assistance;
- duplicate detection assistance;
- photo quality/classification hooks;
- recommendations and valuation foundations;
- AI usage/cost/error metrics.

Also implement:

- multi-signal duplicate candidate generation;
- moderation/anti-fraud rule expansion;
- confidence/reason logging;
- human-review workflow;
- analytics and market-intelligence foundation;
- privacy-safe analytics access controls.

AI must never become authoritative for critical property facts.

## Required tests

- AI timeout/retry/fallback;
- feature-flag off paths;
- duplicate signals/reasons/confidence;
- no auto-merge of uncertain duplicates;
- moderation enforcement without AI dependency;
- analytics privacy and schema versioning.

## Exit criteria

- every AI capability has a non-AI fallback where practical;
- risky AI paths are default-off and kill-switchable;
- duplicate/moderation decisions are auditable;
- analytics access is permission-safe;
- branch/PR/report complete and checks green.

After merge, continue with `docs/PHASE4D_PRODUCTION_READINESS_SPEC.md`.
