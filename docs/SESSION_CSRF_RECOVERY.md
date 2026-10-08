# Recovery of cookie-session CSRF context

Cookie sessions can survive browser restarts and new tabs while the old tab's
sessionStorage CSRF token does not. This caused a code-level gap: GET auth/me
could succeed, while cookie-authenticated POST search/logout required a missing
token. It does not prove the cause of any specific staging 403 without its JSON
response and deployed configuration.

GET /v1/auth/csrf is authenticated by the normal active, unexpired, unrevoked
cookie session. It returns a no-store CSRF token derived through domain-separated
HMAC-SHA256 from that session's validated secret. The response cannot authenticate
a request by itself. Bearer sessions do not use this recovery endpoint.

The guard still accepts legacy random CSRF tokens by stored hash, and also
accepts the derived token using constant-time comparison. No DB mutation or
rotation occurs: concurrent tabs recover the same token without invalidating
other tabs. Wrong session tokens and wrong Origin remain rejected. Normal
session revocation/expiry/account checks apply before token validation.

The web proxy rejects explicit foreign Origin or non-same-origin browser fetch
metadata on this recovery route. Keep API private and CORS restricted to the configured public origin; do not add
cross-origin readable credentialed access to this endpoint. Both API and proxy
responses use no-store. Never log cookies, CSRF responses or ingress secrets.

The browser client recovers context before nonpublic mutations and shares only
in-flight recovery requests. The returned token is not persistently stored.
Anonymous recovery401 permits the original anonymous search request without a
CSRF header. Other recovery errors stop the mutation. Failed mutations are never
automatically replayed. If a different tab changes identity between recovery and
submission, a stale token is rejected; the next deliberate action recovers again.

Recovery reads use ordinary API quotas (300/minute and the existing aggregate
proxy bound), while credential endpoints retain 30/minute and their auth bound.
This prevents map/search interactions from consuming login-attempt quotas.

No schema migration is required. Deploy matching API and web artifacts together;
new web against an old API fails closed when recovery endpoint is unavailable.
Rollback to the old web is compatible with legacy CSRF hash acceptance, but loses
cross-tab recovery. No merge or staging/production deployment performed here.

Staging acceptance still needs the actual deployed SHA and configuration, then:
login, new tab/restart with cookies retained, authenticated search and logout;
repeat with two tabs and account change; verify real reset-email separately.
