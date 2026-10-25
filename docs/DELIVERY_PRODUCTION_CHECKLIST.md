# Delivery production readiness checklist

Status: **unreleased authorization foundation; remote write activation blocked**.

## Implemented

- [x] Actual merged journal/lease/approval/receipt/recovery controls audited.
- [x] Dedicated Delivery ingress; dashboard remains local-only.
- [x] Administrator-mediated server sessions, hashed secret storage, absolute
      expiry, durable revocation, rollback-resistant clock and live grants.
- [x] Exact HTTPS Origin/Host, CSRF, secure host cookie, strict bounded JSON,
      request timeouts, safe response headers/errors.
- [x] Server-reviewed registry; shared-lease Git attestation; exact operation,
      operator/session/workspace/repo/branch/head/base approval binding.
- [x] Live authorization inside atomic approval/transfer intent reservation;
      concurrent replay cannot reserve twice.
- [x] GET-only credential boundary, expiry and durable rejection quarantine;
      no GitHub token in SQLite, HTTP responses or frontend modules.
- [x] Registered recovery under existing Git leases before listening; missing
      or stale unresolved registrations fail startup.
- [x] Real Git/SQLite/HTTP and independent-process runtime restart, contention,
      session persistence and administrator revocation tests.
- [x] No HTTP commit/push/publication/merge/force/reset/delete/retry path.

## Deployment blockers before real operator access

- [ ] Provision and test TLS ingress, exact public Host/Origin, Secure cookies
      and CSRF in a real browser; network policy and secret-free ingress logs.
      Route only Delivery, never the dashboard or Vite.
- [ ] Establish trusted operator verification/enrollment handoff and least
      workspace grants. Add verified SSO/MFA if deployment policy requires it.
- [ ] Provision immutable registry snapshots from real ownership/review records
      and verify them on the target host. Dashboard registry/UI wiring is pending.
- [ ] Provision/rotate real repository-scoped read-only GitHub credentials and
      independently verify actual permissions, expiry and revocation.
- [ ] Configure quotas/rate limits, bounded secret-free audit collection,
      monitoring, private storage and tested backup/restore/rollback procedures.

## SQLite filesystem hardening — operator migration gate (PR #72)

The Delivery data directory must already be owned by the service account and
private (no group/other permissions). Existing `delivery.sqlite`,
`delivery.sqlite-journal`, `delivery.sqlite-wal` and `delivery.sqlite-shm`
files must be regular, owned by that account, private, and have exactly one hard
link. Startup now refuses unsafe paths instead of silently changing permissions.
Do not recursively chmod unknown paths or follow links during repairs.

Before upgrading, stop all Delivery processes and confirm there is no active
SQLite writer. Back up the directory to a private location and record owner,
mode, link count and canonical path of every file. A trusted administrator must
inspect unexpected symlinks, hard links, file types or owners **before** any
correction; never automatically overwrite or remove suspect files. Assess
possible session exposure when an old installation had world-readable files.
Restore known-good data with restrictive permissions, then test WAL
open/restart and retained sessions with a disposable copy.

The directory must not be writable by untrusted local processes. SQLite uses
pathnames for auxiliary files after preflight; these checks do not eliminate
concurrent path-replacement races. A dedicated service account and private,
trusted parent directory remain deployment requirements. Remote GitHub writes
stay disabled.

## Draft PR approval integration (PR #69 merged; not production-enabled)

The server-only `createApprovedDraftPublication` composition now joins the
shared Git lease, refreshed publication plan, independently supplied reviewed
snapshot verifier, complete open/closed PR inventory, atomic one-use approval
consumption + `DeliveryJournal` reservation, GitHub Draft PR receipt
validation, and read-only reconciliation after ambiguous outcomes. Both
approval and journal must use the same SQLite connection. An interrupted
reservation is **not** permission to retry the external create operation.

The older `createDraftPublication` compatibility API still accepts a
non-approved journal reservation. **Do not mount or expose that legacy path
as a production write executor.** The new approved composition is also
unmounted and requires trusted, live operator authorization; its presence
does not activate remote writes.

Before any activation: integrate the approved composition with the reviewed
operator/session boundary and actual least-privilege GitHub write adapter,
independently attest head/base, test genuine multi-process crash/timeout
cases and remote pagination on a disposable repository, then obtain an
independent security review. No unattended PR publication, merge or deploy.

## Additional blockers before any remote write feature

- [ ] Independently review authenticated UI-to-executor wiring and final live
      authorization/revocation races. This implementation mounts no executor.
- [ ] Retain reviewed ownership/snapshot, independent commit/push receipts,
      credential permissions and separate stage approvals under the same Git
      lease through one external attempt and independent receipt verification.
- [ ] Close/audit publication approval-consumption versus journal-reservation
      crash atomicity before exposing a PR writer; transfer atomicity does not
      imply publication atomicity.
- [ ] Run target-platform native end-to-end write/crash tests with a disposable
      repository and actual least-privilege credentials; prove moved ref,
      timeout/revoke/receipt failures never permit blind replay.
- [ ] Integrate stable startup discovery with the real task registry and retain
      unresolved registrations through upgrades and rollback.
- [ ] Independent security review and all required CI green before activation.
      Keep [issue #58](https://github.com/vlovers/ai-office/issues/58) open until
      its remaining gates are proven. No unattended merge/deploy product feature.

## Session-bound GitHub Draft adapter (issue #70; server-only)

The new `createSessionBoundGitHubDraft` composes live `DeliverySessions` grants,
trusted immutable workspace registry refresh, confirmed commit/push receipts,
local Git attestation, exact GitHub head/base SHA attestation, complete remote PR
inventory, atomic approval+journal reservation, one Draft-only POST, and a
separate read-only PR-detail SHA verification. A stored or recovered receipt
is never accepted solely from a branch name or PR URL. Uncertain outcomes do
not authorize retries, even when a remote PR cannot be found.

All GitHub GET/POST requests and response-body parsing have a bounded
15-second default deadline (trusted server configuration: 100 ms to 60 s).
Aborted or hanging adapters cannot indefinitely hold the repository lease.
A timed-out POST is **always ambiguous**: its SQLite reservation remains
uncertain and a subsequent invocation performs only read-only reconciliation.
This bound is not a cancellation guarantee for a remote request already sent.

The final Draft POST boundary synchronously rechecks the live operator grant
and exact commit/push receipts after fresh local Git and remote SHA attestation.
It also asynchronously refreshes the **entire trusted reviewed workspace**
(including repository/worktree identity and head/base SHA) after the last remote
ref GET and before dispatching the single POST. Independent PR-detail GETs
likewise require a fresh matching registry snapshot before confirming either a
new or recovered receipt. Registry errors and swaps after durable reservation
remain uncertain, with no blind replay. A revoked grant, failed transfer check
or asynchronous authorization hook blocks POST. This does not make a remote
GitHub operation atomic with local revocation or registry replacement.

The Draft executor integration tests no longer mutate or delete confirmed Git
transfer receipts to simulate failures: PR #76's immutable SQLite triggers
correctly reject those operations. Missing stages are constructed without an
intent; late journal read failures are injected at the final gate. PR #73 and
PR #76 still require combined branch validation, independent security review
and target-host failure tests before any merge/production activation.

This adapter accepts only trusted server-side configuration and is **not**
registered as an HTTP endpoint. It is not permission to enable production
GitHub write credentials. Real target-host crash/credential tests, independently
reviewed operator ingress and issue #58 remain release blockers.
