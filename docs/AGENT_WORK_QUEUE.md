# Agent work queue

Updated: 7 October 2026. Accepted application baseline: RC PR #37, `9d2ec36`.
This is a bounded coordination update under Issue #15, not launch authorization.

## Completed audit assignments

| Agent               | Owned output                    | Result                                                                                                      |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GitHub/CI reviewer  | `.github/workflows/ci.yml`      | Audit merged history and PRs; match job display name to required `RAUI CI` context without weakening checks |
| Operations reviewer | `docs/STAGING_SERVER_STATUS.md` | Separate observed private VPS evidence from pending external acceptance                                     |
| Product reviewer    | `docs/PRODUCT_GAP_BACKLOG.md`   | Trace saved-search flow, identify range/lifecycle gaps and specify regression acceptance                    |
| Coordinator         | Router and this queue           | Replace obsolete phase selection with owner-defined #40–46 queue                                            |

Each agent owns only its listed files. Completed assignments are not background
workers. New implementation assignments need an active execution session and a
single writer for overlapping search components.

## Next executable assignments

1. Search consistency writer: reproduce and fix preserved-component navigation
   and room/area range loss with failing regression tests before implementation.
   Own search component/page/tests. Handle advanced-filter lifecycle sequentially
   because its form ownership overlaps. See product backlog acceptance criteria.
2. Saved-search presentation writer: summarize stored filters in account cards,
   with account tests. Own account component and a separate summary helper; do not
   edit the search component concurrently with task 1.
3. Release packaging reviewer (#40): prepare a concrete immutable runtime/deploy
   design using existing release contracts; preserve migrations, secrets and
   rollback compatibility. Compose remains local infrastructure only.
4. Recovery reviewer (#42): prepare offsite encrypted backup/recovery procedures;
   identify destination, retention and key-custody inputs before external writes.
5. Observability reviewer (#45): bind real receivers and acceptance procedures
   after private ingress and operator ownership are available.

Autocomplete is not part of the bounded regression repair. Listing address
autocomplete is required by TZ; guest search suggestions additionally need a
source/access contract. No agent may invent provider credentials or expose the
existing authenticated geocoder publicly as a workaround.

## PR and issue triage

- Keep #38 (launch report) and #39 (acceptance templates) active.
- The CI naming fix must run successfully and be incorporated before existing
  blocked PRs can satisfy protected-master checks. Do not remove branch protection.
- #34 targets an already merged branch and conflicts with newer uncertain-cost
  semantics; compare every hunk before retiring it or extracting anything.
- #36 targets the merged Phase 4D branch; recover useful report corrections on
  current master before retiring the companion PR.
- #32 is optional CI parallelization; preserve every current security/release gate.
- Historical merged-phase issues require acceptance reconciliation before closure.

No issues or PRs were closed or merged by this coordination update.

## External acceptance dependencies

#40 DNS/TLS, IAM/registry and remote execution; #41 provider sandboxes and payment
scope; #42 offsite/key custody; #43 independent pentest; #44 representative data;
#45 real receivers and on-call owner; #46 collects their exact evidence.
Local tests and same-VPS restore evidence cannot substitute for these dependencies.
