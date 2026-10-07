# Email password recovery API

`POST /v1/auth/password-reset` accepts `{email}` and returns HTTP 201 with
`{"accepted":true}` for active, unknown and inactive accounts, including when
reset delivery fails. Acceptance means the request was processed; it does not
confirm that an account exists or that a message was delivered. Invalid input
still returns 400 and existing auth ingress rate limits remain in force.

Only reset delivery failures are suppressed. Database/challenge persistence
failures remain errors; email and phone verification keep their existing error
behavior. Operators receive the fixed warning event
`auth.password_reset.delivery_failed`, with no destination, account identifier,
token, URL, provider exception or credentials. Monitor that event for outages.
There is no retry or durable delivery queue for reset messages in this change.
A failed delivery can leave a valid challenge because provider failures can be
ambiguous; it remains subject to the same expiry and one-use rules.

## Timing and performance

Valid anonymous reset requests use a nonblocking 5.1-second minimum response
time, measured after validation and before account lookup. Both account paths
wait for this envelope, covering the configured gateway's five-second timeout
with a small allowance for database work. Invalid input does not wait. This is
a deliberate reset-only security/latency tradeoff and an exception to the normal
300ms API target, even when the mail provider is fast or the account is unknown.
It holds an HTTP connection but does not block the event loop. Keep ingress
abuse controls and size proxy/client timeouts above the response envelope.

This is not a constant-time guarantee: database contention, overloaded event
loops, or an adapter exceeding its timeout can overrun the floor and introduce
timing differences. The existing notification outbox is coupled to product
notifications and cannot carry reset secrets without broader schema/security
work. A dedicated durable recovery queue and further timing/load analysis remain
future improvements; an in-process background send would lose delivery work
during restart. No production performance claim is made by local tests.

## Confirmation and delivery acceptance

`POST /v1/auth/password-reset/confirm` accepts `{token,password}`. Challenges
store only token digests, expire after 15 minutes, and are consumed once.
New requests invalidate prior unused challenges even when the replacement
message fails to send; a successful confirmation
changes the password and revokes existing sessions. No migration is required.

`ConfiguredDelivery` posts `{destination,purpose,token}` to the configured HTTPS
verification gateway with a five-second timeout. Local private delivery files
are development artifacts, not inbox delivery. Production gateway configuration
and real delivery acceptance remain prerequisites tracked by issue #41.
Verify the selected sender (`noreply@raui.ru`), inbox delivery, safe reset links,
expiry/reuse rejection and session revocation with the actual provider before
enabling live recovery. This PR neither configures nor certifies that provider.
Do not put provider credentials or recovery links/tokens in logs or Git.

The separate recovery UI and its email-link guidance are tracked by PR #51
(`docs/EMAIL_PASSWORD_RECOVERY.md` on that branch); this API-only document
preserves those instructions for their eventual integration.

## Rollback

Revert the API change and rebuild/restart the previous artifact; no database
rollback is needed. Reverting reintroduces outage enumeration, so disable public
recovery until a forward fix is deployed. Do not expose private delivery files.
