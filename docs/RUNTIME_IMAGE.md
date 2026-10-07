# Local runtime artifact candidate (issue #40)

This packages the existing services into one non-root image. It supplies a local
acceptance candidate, not staging infrastructure acceptance. Registry approval,
provider IAM, private bindings, TLS/ingress, scan/attestation receipts and an actual
staging smoke remain pending in issue #40 and the launch evidence report.

## Build and identity

Use Node 24 and pnpm 10.0.0 for repository checks. Docker BuildKit is required.
The Dockerfile pins Node 24.19.0 trixie by OCI index digest; Debian Python is >=3.12.
The lockfile is frozen for both build and production dependency installations.
The initial candidate is deliberately a single image retaining the Next runtime,
workspace links, sharp native closure and the sibling Python trust package.

```sh
node scripts/runtime-image-build.mjs --site-url https://staging.example.com --environment staging
```

The builder requires a clean committed checkout and takes the full revision from
Git, then builds from a `git archive` snapshot of that revision. `--candidate` explicitly permits uncommitted local acceptance; its source-state
label is `candidate`, so its revision alone is not an exact source-tree receipt.
Use `--cloud-network` only in the prepared cloud environment: it uses existing
proxy bindings and mounts its CA through a build-only BuildKit secret. It does not
copy the proxy CA into runtime or disable TLS checks. No secrets belong in build
arguments, the build context or image labels.

Inspect and record the actual image ID (`docker image inspect --format '{{.Id}}'
raui-runtime:local`), source-state and revision labels, pinned base and build
origin/environment. A tag is mutable. Pass the immutable `sha256:...` image ID to
acceptance and service launch. No registry upload happens in these commands.
A pinned base and lockfile do not promise byte-identical rebuilds: Debian package
indexes and build outputs can change. Preserve the accepted artifact by digest.

`SITE_URL` and `DEPLOYMENT_ENV` are public build inputs because robots content and
headers are baked by Next. Build a new artifact to change them. The dispatcher
rejects runtime values that differ from the artifact. `API_INTERNAL_URL` remains
server-only runtime configuration; never put it in a `NEXT_PUBLIC_*` binding.

## Roles and configuration

```sh
docker run --rm --network=host --env-file /secure/runtime.env IMAGE_ID api
docker run --rm --network=host --env-file /secure/runtime.env IMAGE_ID web
docker run --rm --network=host --env-file /secure/runtime.env IMAGE_ID migrate
```

Roles: `api`, `web`, `media`, `search`, `commerce`, `professional`, `trust`, `migrate`.
Migrations are a separate explicit action, never automatic service startup. API,
workers and migration retain `/app/apps/api` as their working directory; trust
runs `python3 -m raui_ai.worker` in sibling `/app/apps/ai`. Application dotenv files
are absent: inject runtime configuration instead of using package start scripts.
Unknown roles and unexpected arguments fail before service startup. Only supported
worker flags are accepted; media has no `--once`. The final process receives
signals directly via shell `exec`.

API and web bind loopback as before. The local smoke uses Linux host networking;
publishing bridge ports does not change these bindings. Production networking and
trusted proxy acceptance need their own reviewed configuration. The image defaults
to `NODE_ENV=production`, preserving strict existing startup guards. The local
acceptance harness explicitly selects development adapters and isolated databases;
it does not prove production TLS or provider access. Local object storage needs a
writable private mount owned by UID 1000. Next cache writes use its owned `.next`
directory; read-only deployments require a reviewed cache mount strategy.

## Local acceptance

```sh
pnpm test:runtime
docker run --rm --network=none --entrypoint node IMAGE_ID scripts/runtime-image-check.mjs
node --env-file=.env scripts/runtime-image-smoke.mjs IMAGE_ID
```

Start local infrastructure using `pnpm infra:up` first. The harness first rejects occupied loopback ports and verifies that image PID 1
owns each listening socket; health from another service cannot satisfy readiness.
It creates a new local database and search alias, injects only local adapter configuration, applies
migrations twice, launches image API/web/media, and executes the existing core
fixture with image dependencies. It exercises native image transforms, role
processes, commerce expiry, notification suppression and Python trust jobs. Media
is stopped with SIGTERM after the fixture. It attempts every owned cleanup action even after failures, always removing private
scratch inputs; any cleanup failure is surfaced with a sanitized resource name.
It removes its containers, database, search indexes and private scratch files. It never mounts host code/node_modules.
Run `pnpm infra:down` when the task-owned local infrastructure is no longer needed.

The `context-proof` Docker target exports exactly the allowlisted source context
without executing application build steps. Canary tests should poison ignored
`.env`, credentials, cache, private and backup paths, then inspect this export and
all saved final-image layers for the synthetic marker. Inspecting only the final
filesystem does not establish that earlier layers excluded a secret.

Negative acceptance must reject missing API/Next/Python assets, root execution,
altered SQL migration bytes and origin/environment mismatch. Keep migration SQL
unchanged. Validate real pnpm targets/native execution rather than package names.

Rollback uses the previous accepted image ID and its matching public configuration;
it does not reverse database migrations. Forward fixes build and recheck a new
artifact, applying only new reviewed migrations when needed. This task adds none.
