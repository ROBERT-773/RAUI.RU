# Codex Task Router

Updated: 7 October 2026. This router records the current execution queue;
`AGENTS.md`, the master plan and the task specification remain authoritative.

## Current accepted baseline

Application master: `9d2ec36614a6b4de60f9c8f23a1a99f21bcc73b7` (RC PR #37).
Phase 4A (#27), 4B (#28), 4C (#33), 4D (#35) and RC (#37) have merged.
Do not repeat these phases because their tracking issues remain open.
Reconcile acceptance evidence before closing historical issues.

## Active work: Issue #15

The owner moved launch work from Linear to GitHub issues #40–46.
PR #38 contains the launch evidence report; PR #39 contains acceptance templates.
Neither green CI nor prepared templates establish staging or production acceptance.
The launch recommendation remains NO-GO until required external evidence exists.

| Priority | Issue | Work and prerequisite                                                                                  |
| -------- | ----- | ------------------------------------------------------------------------------------------------------ |
| P0       | #40   | Staging infrastructure: DNS/TLS/private ingress, IAM, services, immutable artifacts and smoke evidence |
| P1       | #41   | Provider sandbox/adapter acceptance; secure bindings and payment scope required                        |
| P1       | #42   | Remote PITR/object/KMS recovery; offsite destination and key custody required                          |
| P1       | #43   | Independent security/pentest, image scan and attestation; real deployed target required                |
| P2       | #44   | Representative staging load; dataset and workload required                                             |
| P2       | #45   | Authenticated observability, real receivers and firing/recovery evidence                               |
| P3       | #46   | Reconcile exact release evidence after prerequisite results                                            |

See [work queue](AGENT_WORK_QUEUE.md), [VPS status](STAGING_SERVER_STATUS.md)
and [product findings](PRODUCT_GAP_BACKLOG.md) for bounded assignments.
Product regression investigation can proceed without declaring a later phase complete.
Autocomplete remains a separate scoped provider/access decision.

## Execution and ownership

1. Read `AGENTS.md`, master plan, TZ and the selected issue/spec.
2. Check Git status and accepted master before selecting a feature branch.
3. Use the existing checkout; no worktree unless explicitly requested.
4. Assign one writer per file set. Read-only reviews may run concurrently.
5. Use Node 24 and pinned pnpm 10 via `/workspace/.raui-tools/node_modules/.bin`.
6. Add meaningful regression coverage and run the required checks.
7. Prepare a PR with exact evidence, limitations and rollback notes.
8. Resolve review/CI findings on the same branch; do not merge or deploy automatically.
9. Distinguish local development, CI, private staging and production evidence.

Agents act only during assigned execution; their names do not imply continuous
background work or independent scheduled Codex sessions. VPS access is currently
operator-mediated, so agents must not claim to execute remote checks themselves.
Never print secret values or use production databases for development tests.

## Repository maintenance

Open historical PRs #32, #34 and #36 require triage against current master.
Do not cherry-pick obsolete AI budget logic or discard newer security/release checks.
Issues #9, #13, #23, #24 and #31 require status reconciliation, not blind closure.
The protected-master required check is `RAUI CI`; CI must publish that exact job name.

## Later gated work

Issue #17 requires an actual authorized release and a satisfied launch gate.
Issues #18–20 remain later stages; bounded current repairs do not authorize completing
those whole stages. Production deployment, migrations and phase transitions retain
the approval rules in `AGENTS.md` and the master plan.
