# Staging alert delivery drill — Issue #45

Status: **prepared, not executed**. This document and its blank receipt are not
deployed observability acceptance. No outage, load, receiver message or remote
configuration change was performed while preparing them.

## Scope and authoritative contracts

This bounded drill verifies one isolated staging scrape-failure notification path:
Prometheus condition -> firing alert -> real receiver -> recovery notification ->
named on-call acknowledgment. It does not complete Issue #45, which also requires
authenticated scraping, dashboard/log/trace correlation, queue/DLQ, PostgreSQL,
Redis, OpenSearch, worker/provider signals and trigger/recovery evidence for the
other critical alerts. It does not satisfy representative load acceptance #44.

Read `AGENTS.md`, `RAUI_MASTER_EXECUTION_PLAN.md`, `RAUI_TZ_v1.0.md`,
`OBSERVABILITY.md` and Issue #45 before execution. Source contracts:

- `infra/observability/prometheus.yml`: job `raui-api`, private HTTPS
  `/v1/admin/operations/metrics`, Bearer credentials from
  `/run/secrets/raui-observer-session`, scrape and evaluation intervals 30 seconds.
  The committed `.invalid` hostname is deliberately inactive.
- `infra/observability/alerts.yml`: `RauiScrapeUnavailable`, severity `critical`,
  expression `up{job="raui-api"} == 0`, `for: 1m`.
- `scripts/observability-check.mjs`: `pnpm observability:check` checks the seven
  rules and synthetic cases offline; it cannot certify receiver delivery.

The observer session has admin privileges. Restrict collector egress to the
metrics GET route, protect and rotate the session through approved secret mounts,
and preserve authentication/rate limits. Never put token values, credentialed
URLs, contact addresses or raw receiver payloads in this document or artifacts.

## Execution prerequisites and ownership

Before executing, record an approved staging-only target, immutable runtime/source
identity, collector identity, isolated network control and its exact rollback.
The target and control must belong to this drill, with no shared customer traffic
or production dependency. Keep the target registered throughout the drill.
Removing it can remove the `up` series instead of making the expression true.

Name the drill operator, configuration/rollback owner, on-call responder and
escalation owner; arrange an approved drill window and real receiver destination
through the existing operational process. Record references, never private contact
details. This runbook authorizes no outbound messages or infrastructure changes by
itself. Execution requires an independently authorized staging drill.

Configure approved collector/alert routing securely outside Git. Verify that the
existing rule reaches the intended receiver, recovery notifications are enabled,
and no silence, inhibition or grouping rule hides this target. Record effective
grouping/delivery delays and an owner-approved maximum outage window. There is no
repository-supplied receiver provisioning or fault-injection command; obtain the
platform-specific commands and review their exact target/rollback before execution.
Do not invent them or disable a shared DB, Redis, OpenSearch or API instance.

## Procedure and evidence

1. Record UTC start time, run ID, owners, source/rule/config identities and the
   approved target reference. Verify healthy authenticated scraping (`up=1`),
   unauthorized rejection and dashboard ingestion. Retain sanitized references
   to this baseline and existing trace/log correlation. Never print the secret.
2. Confirm the fault affects only the owned collector-to-target metrics path.
   Save the exact previous control state and rollback action. Apply the approved
   reversible denial or equivalent isolated scrape failure; keep the same target,
   job and labels. Record fault time and first observed `up=0` with query evidence.
3. Observe the actual alert state through the collector's approved UI/API. Record
   pending and firing times for this instance. The condition must stay true for
   one minute after first evaluation; 30-second scrape/evaluation scheduling and
   routing delay mean delivery is **not guaranteed exactly 60 seconds after the
   fault**. Require real firing and receiver delivery, not elapsed time alone.
4. Capture the receiver's sanitized event reference and firing delivery time.
   Match alert name, instance/run ownership and fingerprint or correlation ID
   across collector and receiver. A local rule evaluation or a synthetic direct
   receiver message is insufficient. Record the on-call acknowledgment and
   response/escalation path. If the maximum outage window is reached, restore
   immediately and mark the drill failed even if no notification arrived.
5. Restore the saved control state; record restoration time. Keep scraping the
   same target and verify `up=1`, healthy authenticated metrics and return to an
   inactive alert state. Retain recovery samples. Do not delete the target as a
   substitute for recovering it.
6. Capture resolved delivery to the same real receiver with matching correlation
   and the responder's recovery acknowledgment. Record actual times and routing
   delays. If resolved delivery is missing, acceptance fails; inspect effective
   routing/recovery configuration through the normal response process.
7. Verify no drill-owned denial, temporary route or stale silence remains; check
   unrelated staging targets remained healthy. Record cleanup owner and result.
   Preserve sanitized immutable receipts; never replay receiver payloads. Restore
   prior collector configuration only after recovery evidence is collected.

Optional read-only queries through the approved collector UI/API (select the
single approved instance, since the first query can return multiple targets):

```promql
up{job="raui-api"}
ALERTS{alertname="RauiScrapeUnavailable",alertstate="pending"}
ALERTS{alertname="RauiScrapeUnavailable",alertstate="firing"}
```

No general shell command is provided for querying protected collector APIs or
injecting the fault: endpoints, identity transport and owned controls are missing
inputs. Do not bypass access controls or expose secrets in command arguments/logs.

## Sanitized receipt template

Copy this structure into the approved evidence store after execution. Use UTC
ISO-8601 times, non-secret references and hashes of sanitized evidence. Keep
unobserved fields `null`; never replace them with predicted times or guessed IDs.

```json
{
  "version": 1,
  "issue": 45,
  "status": "not-executed",
  "runId": null,
  "environment": "staging",
  "runtimeSourceSha": null,
  "runtimeArtifactDigest": null,
  "ruleConfigIdentity": null,
  "collectorConfigIdentity": null,
  "targetReference": null,
  "alertName": "RauiScrapeUnavailable",
  "expression": "up{job=\"raui-api\"} == 0",
  "forSeconds": 60,
  "scrapeIntervalSeconds": 30,
  "evaluationIntervalSeconds": 30,
  "operatorReference": null,
  "rollbackOwnerReference": null,
  "onCallReference": null,
  "escalationPathReference": null,
  "receiverReference": null,
  "maximumOutageSeconds": null,
  "effectiveRoutingDelayReference": null,
  "correlationReference": null,
  "timestampsUtc": {
    "baselineHealthy": null,
    "faultApplied": null,
    "firstUpZero": null,
    "pendingObserved": null,
    "firingObserved": null,
    "receiverFiringDelivered": null,
    "onCallAcknowledged": null,
    "faultRestored": null,
    "firstUpOne": null,
    "alertInactiveObserved": null,
    "receiverResolvedDelivered": null,
    "recoveryAcknowledged": null,
    "cleanupVerified": null
  },
  "evidenceReferences": [],
  "cleanupResult": null,
  "unrelatedTargetsHealthy": null,
  "failureReason": null
}
```

Pass only with observed baseline/firing/recovery, matching real receiver events,
named acknowledgment/response path and verified rollback/cleanup. Timestamp order
must follow observed causality; note clock skew or polling delay explicitly.
Record failures and absent evidence rather than issuing a passing receipt. Even a
passing receipt certifies only this alert path; #45 remains open until its full
deployed acceptance requirements are met.

## Rollback and next gate

The rollback owner restores the saved isolated access/control state immediately
on timeout, unexpected shared impact or operator interruption. If rollback cannot
be verified, escalate via the named path and record an unresolved incident; do not
declare cleanup complete. No application rollback, SQL migration, job retry or
production flag change is part of this drill.

Remaining inputs are approved isolated staging topology/control, collector and
receiver access/configuration, secure observer binding, bounded window and named
owners. Complete this path before planning additional critical-alert drills.
Keep `RauiApiErrorBudgetBurn` and `RauiDependencyUnavailable` acceptance separate;
their triggers must not be inferred from this scrape-failure receipt.
