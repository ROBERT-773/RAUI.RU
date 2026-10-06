# Trusted ingress and rate limits

Web/API forwarding is a private server-to-server boundary. Production requires
`PROXY_IDENTITY_SECRET` (32–256 printable characters, randomly generated and
securely bound to both services), exact `TRUSTED_PROXY_PEERS` socket IPs on API,
`TRUSTED_INGRESS_IP_HEADER` on web and a clean HTTPS `API_INTERNAL_URL`.
None of these is a `NEXT_PUBLIC_` variable. Rotate the secret through coordinated
API/web configuration; never publish identities/signatures or secrets in logs.

Before production, prove that only the approved ingress can reach Next, that it
strips caller-supplied identity headers and sets the configured header from its
socket-derived client IP. Next cannot independently verify that network fact.
Do not enable this contract on a publicly bypassable Next instance. Do not trust
an arbitrary forwarded chain. Keep API private to its approved callers.

The web proxy, SSR detail and sitemap use one transport helper. It overwrites
forwarding signatures, rejects production requests missing a validated identity,
uses verified HTTPS and refuses redirects. API accepts HMAC-SHA256 identities only
from configured socket peers. Signatures bind version, method, exact path/query,
canonical IP and timestamp; the validity window is 30 seconds. Invalid, incomplete,
expired or replayed-for-a-different-target identities fail closed. Clock alignment
is an operational prerequisite. A signature is not authentication or authorization;
normal sessions, CSRF, roles and contextual access checks remain required.

Per-client limits remain 30/minute on auth and 300/minute on other versioned APIs.
Signed proxy traffic also has initial aggregate backstops of 300/minute auth and
3000/minute API per proxy peer. Measure/tune these during representative staging
load; deploy edge/WAF abuse controls and monitor 429s before launch. Public direct
clients retain socket-based limits; arbitrary X-Forwarded-For does not change them.
Production trusted peers without signed identity return 503 rather than collapsing
all users into one bucket. Explicit local development without the contract keeps
its original socket limits so existing smoke tools work without provider secrets.

Verification covers independent quotas and aggregate bounds, spoofed/expired/
method/path signatures, untrusted peers, overwritten caller signatures, unsigned
production rejection and signed SSR/sitemap. Real PostgreSQL/HTTP checks verify
counter identity and rejection without consuming user credentials.

Rollback must coordinate API/web/configuration, retain private ingress isolation
and security fixes, and preserve rate-limit/session/audit records. Prefer a reviewed
forward-fix if older artifacts cannot enforce the boundary safely.
