# Email password recovery

The owner approved email recovery on 7 October 2026 and selected
`noreply@raui.ru` as the sender. SMS and Telegram are outside this change.

## User flow

- The login screen links to `/account/forgot-password`.
- A successful request shows the same conditional message for existing and
  unknown email addresses. It does not claim that a message reached the inbox.
- The verification gateway sends a link with the format
  `<configured WEB_ORIGIN>/account/reset-password#token=<token>`.
  The gateway must use its configured origin, never a request-supplied host.
- The browser captures the fragment token in memory and removes the fragment
  from its current history entry. Tokens are not placed in query strings,
  browser storage, analytics or server access logs.
- The user enters a new password twice (12–128 characters). The API consumes
  the token once, changes the password and revokes existing sessions. The UI
  returns the user to login rather than signing in automatically.

## Existing API and delivery contract

No migration or API contract change is required. Existing endpoints are
`POST /v1/auth/password-reset` with `{email}` and
`POST /v1/auth/password-reset/confirm` with `{token,password}`.
Challenges store token digests and expire after 15 minutes. Requesting another
challenge invalidates earlier unused challenges of the same purpose. Existing
auth ingress rate limits continue to apply.

`ConfiguredDelivery` sends `{destination,purpose,token}` to the configured HTTPS
`VERIFICATION_GATEWAY_URL`, authenticated by `VERIFICATION_GATEWAY_TOKEN`.
For `purpose=reset`, the gateway must format and send the link above from
`noreply@raui.ru`. Preserve existing email-verification and phone-message support.
The provider must not log tokens or message links and must disable click
tracking for recovery emails so token fragments are preserved.

## External prerequisite: real email delivery

The repository currently has an adapter, not a configured mail service. Without
a gateway, development writes messages to the private local delivery file;
production rejects unconfigured delivery. This is not inbox delivery.

Before enabling recovery on staging:

1. Select/configure a transactional mail provider and HTTPS verification gateway.
2. Verify `raui.ru` sender ownership and add the provider's exact SPF/DKIM
   records; check existing records before edits and retain other senders. Configure
   DMARC according to the actual mail policy. Do not invent DNS values.
3. Inject the gateway URL/token through secure environment settings. No secret
   values belong in chat, Git or PR descriptions.
4. Verify real inbox delivery, sender identity and fragment-link preservation.
   Accept only after a delivered link changes the password, reuse/expiry are
   rejected, and previous sessions are revoked.

Provider setup remains tracked by issue #41. This change is code preparation;
it does not deploy the UI, configure DNS/mail, or certify external delivery.

## Rollback

Revert the web routes/component and login link. Existing API, challenges and
database schema remain compatible. Do not expose private local verification
files as a replacement for email delivery.
