# Registration Onboarding Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. User explicitly selected parallel agents and autonomous implementation.

**Goal:** Add contact onboarding and independent staff approval for newly registered users while preserving existing accounts.

**Architecture:** Add a default-approved user state and durable approval requests; centrally restrict pending sessions. Separate UI components consume existing verification contracts and a new scoped staff API.

**Tech Stack:** Node24, pnpm10, NestJS, PostgreSQL, Next.js, React, TypeScript.

**Spec:** ../specs/2026-10-08-registration-onboarding.md

## Global Constraints

- Existing checkout, feature branch; no merge/deployment or real provider messages.
- Additive migration only; current users remain approved.
- Existing long-token gateway contract is unchanged; do not claim numeric SMS delivery.
- Separate registration permissions; approval never verifies contacts or changes activation/role.

## Review Focus

- Pending bearer/cookie requests cannot bypass the route restriction.
- Revoked staff grants block decisions, including idempotency replay.
- Failed email dispatch after creation does not cause duplicate-registration retries.
- Concurrent decisions and deactivation do not grant access incorrectly.
- Logout/account switching does not apply stale verification or private queue results.

## Tasks

- [ ] Backend agent: migration016, current approval state in Actor/public user, restricted onboarding routes, pending creation, sanitized partial-delivery response; regression tests first.
- [ ] Backend agent: scoped queue/detail/decision module, fresh transaction authorization, lock order user then request, active+verified checks, self-review denial, idempotency and audit; integration tests for races and retries.
- [ ] Profile agent: AccountProfile({onRefresh?}) loads own profile, existing contact request/confirm endpoints, pending status/reason, refresh and late-result guards; component tests first.
- [ ] Account agent: buyer/owner selector, safe registration response, pending collection suppression, profile link/panel and identity guard; tests first.
- [ ] Staff UI agent: registration queue/detail/reason/decision screen and delegated permission selector; component tests first.
- [ ] Root: strict OpenAPI schemas and bounded proxy allowlist with negative-route tests, owner onboarding link, review integration.
- [ ] Integration agent: real HTTP and populated migration coverage; preserve legacy synthetic users as approved explicitly when testing unrelated behavior.
- [ ] Root: lint/types/full tests/build, isolated integration/migration/smoke, independent security review, push/PR and exact-head CI evidence. Report limits and rollback.
