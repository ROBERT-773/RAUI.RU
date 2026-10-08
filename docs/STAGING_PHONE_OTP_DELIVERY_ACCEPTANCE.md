# Controlled staging phone OTP delivery acceptance

Status: **NOT EXECUTED**. This document prepares a bounded staging check; it
records no real SMS delivery, enablement, deployment or provider change.
Implementation evidence and boundaries are in `PHONE_OTP_VERIFICATION.md`.

## Prerequisites

- Name a staging operator and an explicitly authorized controlled recipient. Get
  authorization for this live send before execution; general development approval
  is not recipient authorization. Never request secret values in chat.
- Record the isolated staging target and immutable application commit. Confirm
  the complete migration 001–017 ledger/checksums match the release and
  registration approval and the six-object publication
  limit remain enforced. Do not use an older API that bypasses these policies.
- Obtain gateway contract, Russian coverage, sender/template and billing/quota
  approvals. Confirm secure bindings for `PHONE_OTP_PEPPER`,
  `PHONE_OTP_GATEWAY_URL` and `PHONE_OTP_GATEWAY_TOKEN` by presence only.
- Confirm the controlled account is active and its phone is reserved for this test
  without another account's verified-phone conflict. Record initial approval,
  role, activation, email-verification and phone-verification states privately.
- Select the delivery observation deadline before execution, for example 120
  seconds from request initiation. Its effective deadline is the earlier of that
  timestamp and the returned code expiry; it must never exceed the five-minute
  code lifetime. Record the selected duration. The send cap is **one**.

## Ordered check

1. Using the authorized staging change procedure, enable numeric OTP only in the
   isolated staging scope. Open the authenticated profile and confirm numeric OTP
   capability. Capability availability alone does not establish provider readiness.
2. Initiate one code request with a fresh idempotency key. Record request time,
   challenge ID and returned expiry. Do not record the key, code, full phone,
   credentials or raw provider payload. Do not resend or use legacy phone requests
   during this drill.
3. Record gateway acceptance independently. A valid gateway acknowledgment is
   HTTP 202 with exactly `version:1`, the matching `challengeId` and
   `accepted:true`. Obtain sanitized operator evidence; never expose raw payloads.
   If the acknowledgment cannot be evidenced, mark acceptance unconfirmed.
   An API `accepted` result means gateway acknowledgment, **not handset delivery**.
4. Ask the authorized recipient to attest whether the SMS arrived before the
   effective observation deadline. Record receipt time and a masked recipient
   reference only. Do not capture the SMS or code in screenshots, logs or reports.
   No receipt by the deadline leaves delivery failed or unconfirmed, even when
   gateway acceptance succeeded.
5. If received before expiry, enter the six-digit code in the browser. Refresh the
   authoritative profile and confirm populated `phone_verified_at`. Verify that
   approval, role, activation and email-verification states are unchanged; a
   pending registration must remain pending. Record account verification separately
   from gateway acceptance and handset receipt.
6. Restore `PHONE_OTP_ENABLED=false` through the staging change procedure and
   verify numeric capability is disabled. Record the rollback result. Retain
   migration 017 and its tables, verify and retain the complete 001–017 ledger
   and checksums, keep legacy long-token routes
   available, and preserve approval and publication-limit guards. Do not rotate
   the pepper during this drill.

## Abort and rollback

Abort on unexpected routing, code/secret exposure, quota excess, mismatched
acknowledgment, expired code, deadline breach, unintended identity/policy changes,
or loss of isolation. Stop sends and restore the disabled flag as in step 6. Do
not automatically retry an `unknown` dispatch: an SMS may still arrive. A later
attempt needs its own authorized bounded drill and must respect server cooldowns
and quotas. Do not remove additive database tables or downgrade to a policy-bypassing
API. If flag-off cannot be verified, mark rollback failed and escalate to the named
operator rather than declaring acceptance complete.

## Sanitized receipt template

Keep actual operational evidence in the approved restricted evidence store. This
repository template intentionally contains no recipient, credentials or execution
claims. Use UTC ISO8601 timestamps (for example, the `Z` suffix) only for
observed events; unobserved timestamps remain null. Record an immutable runtime
artifact digest only if independently available, never infer it from a source SHA.
Evidence references must identify sanitized records without credentials, contacts
or raw message/provider payloads. Use separate verdicts; all remain
`not_executed` until observed.

```json
{
  "version": 1,
  "status": "not_executed",
  "operator_reference": null,
  "recipient_authorization_reference": null,
  "masked_recipient_reference": null,
  "staging_reference": null,
  "application_commit": null,
  "runtime_artifact_digest": null,
  "migration_001_017_ledger_checksums_verified": null,
  "evidenceReferences": [],
  "prerequisite_approval_references": [],
  "secret_bindings_present": null,
  "selected_wait_seconds": null,
  "effective_deadline_at": null,
  "send_cap": 1,
  "send_requests_initiated": 0,
  "request_started_at": null,
  "challenge_id": null,
  "expires_at": null,
  "gateway_acceptance": { "verdict": "not_executed", "observed_at": null },
  "handset_delivery": { "verdict": "not_executed", "received_at": null },
  "account_verification": { "verdict": "not_executed", "observed_at": null },
  "approval_role_activation_email_unchanged": null,
  "publication_limit_preserved": null,
  "flag_off_rollback": { "verdict": "not_executed", "observed_at": null },
  "abort_reason": null,
  "final_verdict": "not_executed"
}
```

Gateway acceptance, handset delivery and successful account verification require
separate evidence. Captured-adapter tests, healthy API readiness and green CI do
not substitute for this controlled external acceptance check.
