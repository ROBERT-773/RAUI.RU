# Owner and publication moderation workflows implementation plan

User requested direct continuation. Work in existing checkout, dedicated branch, no merge or deployment.

Spec: docs/superpowers/specs/2026-10-08-owner-moderation-workflows.md

- [x] Add optional idempotency key to existing CSRF-aware client, with regression test.
- [x] Add narrow property and staff moderation proxy routes, including private images; test permitted methods and rejection of other admin routes/variants.
- [x] NewListing: dynamic category definitions, explicit Moscow/MO address and coordinates, typed characteristics, property→listing creation, frozen retries, guarded async state, completion/reset. Component tests include failure recovery, stale category, parent disabled and unmount.
- [x] OwnerListings: eligibility, owned pagination/open, edit price/text with version, pause publication, upload with processing state, guarded resubmission and visible rejection reason. Tests cover private denial, unverified phone, versions, publication route and protection of unsaved changes.
- [x] Staff workbench: pending cases, version matching, scoped images/known characteristics, advisory warnings, manual reasoned confirmation, stable decision retry and queue refresh. Component tests cover denial and stale/unmount responses.
- [x] Real browser flow using isolated synthetic seller/admin identities and media worker: create→photo ready→submit→approve→public detail; clean up by archive. Guest/unverified UI checks.
- [x] Run lint, typecheck, full tests and build; production-built smoke and 26 real browser tests on desktop/mobile Chromium passed. Independent authorization/race review passed after the coordination regression fix.
- [ ] Run full CI with existing integration/E2E/migration/recovery/smoke/release gates on final SHA.
- [ ] Push and prepare PR, with no migrations and application rollback notes.
