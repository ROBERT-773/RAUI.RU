# Runtime packaging acceptance — Issue #40

Status: preparation only; no image built, uploaded, scanned or deployed by this
checklist. Production remains NO-GO. This document defines sanitized receipts;
blank fields and unchecked items are outstanding work, not acceptance evidence.

Reviewed source baseline: `9d2ec36614a6b4de60f9c8f23a1a99f21bcc73b7`.
For an actual release, substitute its exact accepted source SHA and successful CI
run; this baseline reference does not identify the currently running VPS image.

## Build input and runnable image

The readiness artifact is a verified build input. Its verifier hashes API dist,
12 migrations, Next `.next` output, observability files, root package/lockfile and
load/recovery evidence. It does not supply a complete installed runtime workspace.
See `scripts/release-contract.mjs`, `.github/workflows/ci.yml` and
`RELEASE_ROLLBACK.md`. Do not treat extraction as a deployable installation.

- [ ] Verify successful exact-SHA CI provenance for `.github/workflows/ci.yml`,
      retained artifact identity, manifest run ID and every file hash using the
      trusted verifier from that source. Reject expired/missing artifacts.
- [ ] Preserve all 12 migration bytes/checksums; retain migration ledger and
      compatibility evidence. Packaging must never apply migrations itself.
- [ ] Record an approved registry/repository and immutable runtime image digest;
      a mutable tag alone is insufficient. Record base-image digest separately.
- [ ] Use Node `24.19.0` from `.nvmrc` and pnpm `10.0.0` from root packageManager;
      lockfile installation remains frozen. Record actual runtime versions.
- [ ] Include workspace manifests, `pnpm-workspace.yaml`, the lockfile and the
      runtime dependency closure, with usable workspace links. Build-only tools
      must not be mistaken for production dependency availability.
- [ ] Preserve required workspace files: `@raui/config` exports
      `ingress.mjs`; `@raui/types` and `@raui/ui` export source files and the web
      config transpiles these packages. Do not invent compiled workspace outputs
      or assume copying API dist and `.next` alone resolves their imports.
- [ ] Include Next server/static output and any source-SHA `apps/web/public`
      assets. That directory is absent at the reviewed baseline; record absence
      explicitly rather than claiming files were copied. Current Next config has
      no `output: 'standalone'`; do not assume a standalone server exists.
- [ ] Record native runtime dependencies and target platform compatibility
      (including sharp), filesystem ownership, required mounts, restart/resource
      policy and trusted ingress bindings. `infra/compose.yaml` is local only.

## Entrypoints and working directories

These are existing package-script contracts, not an approved container command.
API scripts use `--env-file=../../.env`; choose a protected runtime mount/layout
or a separately reviewed equivalent injection contract. Never bake `.env` into
an image. Web start binds loopback; private ingress/bind topology must be explicit.

| Role                      | Existing command                                              | Working directory |
| ------------------------- | ------------------------------------------------------------- | ----------------- |
| API                       | `node --env-file=../../.env dist/main.js`                     | `apps/api`        |
| Web                       | `next start --hostname 127.0.0.1`                             | `apps/web`        |
| Media worker              | `node --env-file=../../.env dist/worker.js`                   | `apps/api`        |
| Search worker             | `node --env-file=../../.env dist/search-worker.js`            | `apps/api`        |
| Commerce worker           | `node --env-file=../../.env dist/commerce-worker.js`          | `apps/api`        |
| Professional worker       | `node --env-file=../../.env dist/professional-worker.js`      | `apps/api`        |
| Trust worker              | `node --env-file=../../.env dist/trust-worker.js`             | `apps/api`        |
| Separate migration runner | `node --env-file=../../.env dist/modules/database/migrate.js` | `apps/api`        |

- [ ] Verify each executable/dependency exists inside the actual image, under its
      actual UID/GID and working directory. Confirm required worker inventory;
      document any explicitly excluded capability and keep dependent flags off.
- [ ] Record claim/drain/lease and bounded reconciliation procedures. `--once`
      does not imply a time limit; use the approved operator bound.
- [ ] Do not run repository fixture smoke scripts unchanged against real provider
      bindings; prepare isolated sandbox identities and bounded acceptance.

## Configuration, security and compatibility receipts

- [ ] Record configuration revision and injection mechanism, never secret values,
      connection strings, tokens, private keys or environment contents.
- [ ] Bind `DEPLOYMENT_ENV` and `SITE_URL` consistently at web build/runtime;
      confirm API origin, signed trusted ingress and coupled API/web/config
      compatibility. Record providers and audited flag state without activating
      them during packaging.
- [ ] Attach runtime-image vulnerability scan, SBOM and attestation references
      tied to the exact digest. Review unresolved findings against the security
      gate; local dependency checks do not certify the image.
- [ ] Attach runtime import/start checks, health and full worker acceptance from
      authorized isolated infrastructure. No checks here imply deployed success.
- [ ] Retain previous compatible image/config, immutable migrations and queues.
      Roll back code only when schema/provider/security compatibility permits;
      otherwise prepare a reviewed additive forward fix. No down migrations.

## Operator receipt

| Evidence                                              | Identifier/reference (sanitized) |
| ----------------------------------------------------- | -------------------------------- |
| Accepted full source SHA / successful CI run          |                                  |
| Artifact ID, retention expiry / manifest SHA-256      |                                  |
| Runtime image registry / digest / build timestamp     |                                  |
| Base image digest / platform / Node and pnpm versions |                                  |
| Dependency/workspace installation and import check    |                                  |
| API/web and five-worker entrypoint receipts           |                                  |
| Migrations 001–012 checksum / compatibility review    |                                  |
| Public-assets status / mounts / config revision       |                                  |
| Workload identity / protected environment reviewers   |                                  |
| Image scan / SBOM / attestation                       |                                  |
| Runtime smoke / worker drain and recovery evidence    |                                  |
| Compatible rollback image/config / forward-fix notes  |                                  |
| Operator / reviewer / remaining blockers              |                                  |

Acceptance requires completed applicable receipts plus the deployed evidence in
Issue #40 and the launch gate. This checklist authorizes no image publication,
provider activation, migration execution, merge or deployment.
