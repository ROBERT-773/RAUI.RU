# Operations and observability

`GET /v1/admin/operations` and `/metrics` use the existing verified-session admin
boundary. They return aggregate queue states, dependency status, versioned flags,
last-hour payment failures/AI provider failures and uncertain-attempt counts.
Planned AI fallback has a separate gauge and does not trigger a provider alert. They expose
no job payloads, recipients, contacts, credentials or raw upstream errors.
Read-only endpoints do not mutate jobs or flags; use existing audited retry and
flag APIs for changes. Metrics access must remain private and authenticated.

HTTP duration histograms use only registered OpenAPI route templates, seven
allowed methods plus OTHER and status classes. Unknown routes share `unmatched`;
queries, identifiers and caller-supplied request IDs never become labels. Every
response carries a generated span and strictly validated W3C trace correlation.
Structured `http_span` logs join on traceId/spanId; request bodies, raw errors and
URLs are absent. OpenSearch green/yellow is usable (yellow means replica redundancy is degraded);
red/malformed/oversized responses fail the probe. Ingest these JSON spans into the approved log/trace collector;
external collector transport and retention require staging configuration. This
implementation does not claim an installed remote APM system or browser tracing.

Proposed staging SLO: ordinary internal API p95 <=300 ms and 99.9% availability
per 30 days, excluding deliberately external-provider operations. The first local
load report must state its workload; production sizing and the final SLO need
staging measurement and owner acceptance. Error-budget burn alert uses a 14.4x
threshold, latency >300 ms for ten minutes, dependency/scrape failure one minute,
queue pending/running age >300s for five minutes, dead jobs and >5 provider failures
per hour for five minutes. Tune from measured staging traffic, retain alert history.

Portable `infra/observability` contracts include Prometheus rules, scrape config
and Grafana dashboard. The `.invalid` target deliberately prevents accidental
activation. Bind private HTTPS ingress and securely rotate the observer session
before deployment; tokens expire according to existing SESSION_DAYS and require
operator renewal. Do not grant a public metrics bypass. Scrape once per 30s per
instance; existing rate limits remain active. Counters reset on process restart;
Prometheus rates handle resets. Queue/provider snapshots are global aggregates,
not tenant/customer analysis.

For an alert: correlate spans with status and dependency panels; check worker
process/lease/queue age before an audited retry. Inspect transaction contention
and search health; disable affected AI/commerce flags through audited APIs when
appropriate. Preserve immutable audit/billing data. CDN, payment, delivery, S3
and AI gateway infrastructure also need the providers' own dashboards and blackbox
checks before real launch; a local green API check cannot certify those services.
