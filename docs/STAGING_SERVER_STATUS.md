# Staging server status

Recorded: 7 October 2026 (UTC).

**Production recommendation: NO-GO.** The manually prepared VPS provides development/staging evidence. This record does not certify the production launch gate or authorize a deployment.

## Evidence and scope

The observations below come from operator-supplied screenshots and status reports. The documentation agent has not accessed the VPS, checked its running configuration, or independently repeated these requests. No SSH credentials, environment values, session tokens or backup contents are recorded here.

The application baseline identified for this staging work is master `9d2ec36614a6b4de60f9c8f23a1a99f21bcc73b7` (`9d2ec36`). Its repository/CI evidence is documented in [the launch gate report](https://github.com/ROBERT-773/RAUI.RU/pull/38). The running VPS image/source SHA, image digests and configuration identity still require an operator receipt; the baseline alone does not prove runtime provenance.

## Reported observations

| Area                  | Operator-reported evidence                                                                                            | Remaining verification                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Host                  | Ubuntu 24; VPS `109.73.196.76`; manual setup                                                                          | Patch state, firewall/network exposure, storage capacity and reboot recovery                                     |
| Containers            | Six: PostgreSQL, Redis, OpenSearch, API, search worker and web                                                        | Immutable image identity, restart policy, mounts, resource limits and complete required worker inventory         |
| Application hardening | Application containers use UID/GID `1000:1000`, drop all capabilities and set `no-new-privileges`                     | Effective runtime configuration, filesystem permissions, secret handling and runtime image security              |
| Database identity     | Application database login has limited permissions                                                                    | Exact least-privilege grants, migration/backup identity separation and trusted transport                         |
| Requests              | Web/API health returned 200; reported search request returned 201; registration, login and session flows were checked | Exact routes, runtime configuration, HTTPS cookies/CSRF/CSP, authorization and representative product flows      |
| Development access    | Private development configuration through an SSH tunnel                                                               | Repeatable secure access procedure and private dependency/ingress topology                                       |
| DNS/TLS               | `staging.raui.ru` unresolved; TLS absent                                                                              | DNS publication, certificate issuance/renewal and public HTTPS acceptance                                        |
| Backup                | Database dump and roles saved on this VPS; restored into a scratch database on the same VPS                           | Automated encrypted offsite retention, independent restore, WAL/PITR, key recovery, objects and measured RPO/RTO |

## Workers and service coverage

Only the search worker appears in the reported six-container inventory. The repository release sequence also expects media, commerce, professional and trust workers, alongside API and web. An operator must verify whether those workers run elsewhere; their absence from this inventory is not proof of absence from the host.

Each required worker needs a documented runtime entry point, feature/provider prerequisites, lease/drain procedure, restart behavior and bounded acceptance check. If the approved staging scope excludes a worker or capability, record that decision explicitly and keep dependent features disabled. Search health alone does not certify media processing, commercial reconciliation, professional imports/notifications or trust/analytics jobs.

## Gaps and execution boundaries

- There is no verified reproducible VPS deployment or reboot/recovery exercise. Repository `infra/compose.yaml` is explicitly local development infrastructure and must not be treated as a production deployment contract.
- Same-host dump/restore proves a limited restore path; VPS loss can remove both source and backup. Offsite storage, automation, retention, recovery key custody and independent recovery remain outstanding.
- Deployed monitoring, authenticated scrapes, dashboards, alert receiver firing/recovery and named on-call coverage remain outstanding.
- Protected release environments, approved runtime/registry identities, provider acceptance, live feature-flag state, representative staging load and independent penetration testing remain unverified.
- Existing repository core/search smoke scripts create development fixtures and use local adapters. Do not run them unchanged against real provider bindings or production-shaped ingress; prepare bounded sandbox acceptance first.

Agents can prepare versioned configuration, operator instructions and sanitized evidence templates in the repository. Actual VPS changes, DNS/TLS activation, backup destinations and provider bindings require the authorized operator and securely supplied configuration. Production migration, deployment, rollback or cutover requires its separate explicit task.

## Prioritized work queue

Issues #40–46 form the staging-readiness queue. Ownership and detailed dependencies are maintained in the central work router.

| Priority | Work package                  | Acceptance evidence                                                                                                                                                     |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | #40 — Staging infrastructure  | DNS/HTTPS/private ingress, exact runtime identities, reproducible operator deployment/rollback, required worker inventory, reboot exercise and basic offsite protection |
| P1       | #41 — Providers               | Approved provider bindings, payment scope/adapter decision, sandbox acceptance and audited feature-flag state                                                           |
| P1       | #42 — Remote recovery         | Automated encrypted offsite backups, WAL/PITR, object/KMS recovery, isolated restore and accepted measured RPO/RTO                                                      |
| P1       | #43 — Independent security    | Independent penetration test and resolution or explicit acceptance of findings                                                                                          |
| P2       | #44 — Representative load     | Isolated representative dataset, bounded reads/writes/import/provider traffic, migration/worker drain timings and capacity evidence                                     |
| P2       | #45 — Alert receivers         | Private authenticated scrape, deployed dashboards, real alert firing/recovery and named on-call/escalation owner                                                        |
| P3       | #46 — Evidence reconciliation | Current exact-master CI/artifact receipts and refreshed launch acceptance matrix after prerequisite work                                                                |

The production gate remains open until the requirements in [the launch checklist](PRODUCTION_LAUNCH_GATE.md), [release procedure](RELEASE_ROLLBACK.md), [backup/DR contract](BACKUP_DR.md) and [observability contract](OBSERVABILITY.md) have actual acceptance evidence. This file records progress and gaps, not completed launch acceptance.
