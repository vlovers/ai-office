# Delivery authorization threat model

Status: unreleased foundation; remote writes disabled. See the
[security runbook](DELIVERY_PRODUCTION_SECURITY.md).

Assets: operator authority, workspace/repository identity, reviewed commits,
approvals, journal integrity and server GitHub credentials. Browser JSON/headers,
repository content and GitHub bodies are untrusted. The OS administrator,
private config/SQLite, verified enrollment handoff, Git executable and credential
provider are trusted. TLS ingress is trusted for transport/routing, never for
asserted operator identity. The local dashboard is outside this ingress.

Attackers may control a website or another workspace/session, forge/replay
requests, modify untrusted Git content, race another process, induce errors or
restart the server. Same-OS-user database/config compromise is outside the
application's isolation guarantee: that principal can provision authority.

| Threat                                                | Enforced control                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Forged operator/admin/session/workspace claims        | Opaque server-resolved session; strict JSON; live explicit workspace/operation grants                         |
| Session fixation or enrollment replay                 | New random bearer; atomic one-use 60-second ticket exchange                                                   |
| Session theft after logout/disable/expiry             | Durable revocation, absolute expiry; no revival on re-enable                                                  |
| Clock rollback across restart                         | Persistent watermark and exact-watermark checks, fail closed                                                  |
| Login/action CSRF or sibling-origin attack            | Exact HTTPS Origin/Host; enrollment custom header; session CSRF; Strict cookie; Fetch Metadata                |
| DNS rebinding / forwarded identity spoofing           | Exact configured Host; proxy claims ignored; separate ingress                                                 |
| Duplicate cookies / malformed or large JSON           | Reject ambiguity; 8 KiB body cap; bounded strict schemas                                                      |
| Cross-workspace/stage escalation                      | Server grants checked for selected resource and exact operation; independent approve/reserve rights           |
| Same operator, different session approval replay      | Ledger binds server session UUID as well as operator                                                          |
| Approval copied to another branch/repo/SHA            | Immutable registry, review key, managed branch, destination and exact head/base binding                       |
| Revocation while Git/provider awaits                  | Recheck after asynchronous work and inside final intent transaction                                           |
| Concurrent replay or approval/intent crash gap        | Shared Git lease, atomic consume+intent, unique workspace/stage, uncertain restart state                      |
| Forged commit/push receipt                            | Exact-identity journal checks; independent verification required; no HTTP receipt-writing route               |
| Unsafe remote write or blind retry                    | No HTTP executor; credential adapter permits exact-repository GET only                                        |
| Credential exfiltration to foreign host/repo/redirect | Server provider only, fixed allowlists and no redirect following                                              |
| Expired/revoked credential, 403/429/timeout           | Expiry checks, durable 401/403 quarantine, no anonymous fallback/retry                                        |
| Secret in errors/logs/bundle                          | Fixed errors, bounded upstream bodies/header removal, no app logging, server-only modules and minimal Git env |
| Hook/filter helper or credential-bearing Git stderr   | Existing hardened Git runner and sanitized local attestation failures                                         |

Residual boundaries: XSS or a compromised extension can act as a live session
and retrieve its CSRF token. HttpOnly alone does not prevent same-origin action.
The API serves no HTML/scripts and uses a restrictive CSP; later UI needs review.
External same-user Git writers do not honor leases; attestation is not a hostile
filesystem transaction. Trusted low-level server libraries must not become
alternate HTTP paths. Stored approvals do not prove current session authority.

The registry trusts an administrator's independently reviewed fingerprint/SHAs,
then verifies actual clean Git state. It does not adopt arbitrary worktrees or
establish ownership from browser assertions. GitHub scope metadata is provider
attestation, not token introspection; independently audit actual permissions.

DoS quotas, enrollment assurance, audit retention, backup/encryption, TLS/proxy
and account policies require deployment controls. Body/time/output bounds do
not establish distributed rate limiting, MFA, comprehensive secret scanning or
isolation against host administrators. The
[production checklist](DELIVERY_PRODUCTION_CHECKLIST.md) records remaining gates.
