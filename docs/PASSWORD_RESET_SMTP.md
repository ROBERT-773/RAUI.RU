# Password reset SMTP transport

Issue #60 adds an opt-in RU-CENTER transport behind `VerificationDelivery`.
It applies only to password reset. Email and phone verification keep their
existing gateway or local development behavior.

Set `RESET_SMTP_ENABLED=true`, inject `RESET_SMTP_PASSWORD` securely and use a
clean HTTPS `WEB_ORIGIN` (scheme and host only, no credentials, path, query or
fragment). The disabled default does not contact SMTP. Never put credentials in
Git, logs or chat.

This bounded adapter fixes the endpoint to `mail.nic.ru:465`, implicit TLS with
certificate and hostname verification, AUTH LOGIN and sender/login
`noreply@raui.ru`. Each operation gets its own connection. One total five-second
deadline covers DNS, TCP, TLS, greeting, authentication and message acceptance;
expiry destroys the socket and blocks late callbacks. Provider errors become
`Verification delivery unavailable`, without raw SMTP details. Logging and
external file/URL loading are disabled.

A timeout leaves delivery outcome uncertain if DATA was already transmitted.
Closing the local connection prevents new commands; it cannot withdraw a message
already received by the provider. The adapter never retries automatically.

The plain-text message uses
`WEB_ORIGIN/account/reset-password#token=<43-character token>` and explains the
existing 15-minute expiry. The token is never placed in a query string. Token
creation, hashing, expiry and consumption are unchanged. This PR depends on
#53's reset request privacy protection. The reset UI in #51 is a separate
change; this adapter alone does not deliver that UI.

An existing `VERIFICATION_GATEWAY_URL` always takes priority. Failure of that
gateway never falls back to SMTP. Enabled SMTP configuration must still be
complete when a gateway is present. The production requirement for an HTTPS
verification gateway is unchanged, so SMTP cannot replace that gateway in
production under this contract. Direct SMTP requires both `NODE_ENV` and
`DEPLOYMENT_ENV` to be non-production and no verification gateway configured.
`DEPLOYMENT_ENV=staging` with `NODE_ENV=production` still requires the production
verification gateway, which takes precedence over SMTP. Do not weaken production
validation to activate direct SMTP.

Local tests use a temporary synthetic certificate trusted only by the test
connector and a loopback SMTP server. They exercise TLS, LOGIN, envelope, MIME
content, rejections, deadlines, socket cleanup and transport precedence. They
never contact RU-CENTER or send real messages. Provider credentials, DNS,
production configuration, actual inbox delivery and provider acceptance remain
external gates tracked in #41.

Rollback: disable `RESET_SMTP_ENABLED` or revert this PR. No schema changes or
migrations are added. Forward fixes must retain the gateway priority, verified
TLS and the total deadline. Live activation, sending and deployment require a
separate task.
