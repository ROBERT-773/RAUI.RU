# Staff two-factor authentication

The launch gate requires server-verified second-factor assurance for all
administrator-only and delegated staff reads and writes. Use authenticator-app
TOTP so enrollment and verification can be tested on the isolated staging
instance without a delivery provider.

1. Add a TOTP verifier in the API auth module. Test RFC 6238 vectors, both sides
   of a time boundary, malformed input and the permitted clock window. Return
   the matched time step for atomic replay prevention.
2. Add an additive migration for encrypted staff factors and session-bound
   assurance. Keep the encryption key server-side. Verify enrollment before
   activating a factor. Consume a matched time step atomically when verifying
   a challenge. Revoking or replacing a factor must invalidate its assurances
   immediately. Document provisioning and recovery without logging secrets.
3. Add authenticated, rate-limited enrollment and verification routes and
   document their OpenAPI contracts. Apply assurance checks in `SessionGuard`
   for both administrator-only and delegated staff routes before any handler
   or idempotency lookup runs. Preserve the existing role and grant checks.
4. Add the enrollment and challenge screens in the account and staff flows.
   Verify normal login, challenged staff access, discarded or expired
   challenges, revoked factors, idempotent replay and loss of staff rights in
   API integration and browser tests.
5. Apply and verify the migration on the isolated staging database. Run lint,
   typecheck, tests, build, integration, E2E and smoke. Keep launch blocked
   until the configuration, enrolled staff and recovery have been verified.

## Staging and recovery

Apply the additive migration with the normal migration command. Inject
`STAFF_TOTP_ENCRYPTION_KEY` as a server secret containing 32 random bytes in
hex. Set `STAFF_TOTP_REQUIRED=true` in the isolated environment and restart
the API. Administrators and delegated moderators can enroll from their
existing staff pages after entering their account password. Verify a fresh
session requires an authenticator code and that normal public and account
requests continue to work.

For a lost device, verify the employee out of band and record the approved
recovery in the operational audit log. An authorized database operator must
delete the employee's factor and revoke all of their sessions, in that
order, in one transaction. Require a fresh login and enrollment. The enforcement
setting remains enabled throughout recovery. Never capture passwords,
authenticator keys, or codes in tickets, traces, or logs.

If a deployment must be rolled back, preserve the migration and encrypted
records. Keep staff routes unavailable until a build enforcing the second
factor is serving them. Exercise this recovery procedure on test accounts
before opening staff access in production.
