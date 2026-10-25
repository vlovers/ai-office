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

## Draft PR approval integration (PR #69; not production-enabled)

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

## Read-only commit/push receipt reconciliation (issue #58)

The server-only `reconcileGitTransferReceipts` helper now reconciles **existing**
commit/push intents under the same repository/worktree lease as publication.
It validates the trusted reviewed operation, re-attests the real local Git
worktree and exact head/base commits, then uses bounded GitHub GET requests to
verify both remote refs before confirming a push receipt. Revocation, changed
refs, dirty worktrees, 403/429/5xx, malformed responses and timeouts leave the
relevant stage blocked/uncertain. An absent intent is never created, and an
absent remote ref never permits another push.

The caller must supply `refreshReviewed` from the trusted server registry,
not browser input. Reconciliation rechecks the **entire reviewed binding**
(operation, workspace, repository/worktree paths and Git directories, head/base
SHAs) inside the lease, after local Git reads and after remote GETs, before
confirming either receipt. If the registry changed, the stage remains blocked/uncertain. Existing
push intents require an already confirmed matching commit receipt; inconsistent
or corrupted confirmed receipt SHAs are rejected before any journal mutation.
These guards do not replace independent session/grant authorization or prove
that a previous remote write was initiated by this service.

Cancellation of a read-only recovery is also fail-closed. An external
`AbortSignal` rejects the remote attestation even when a custom GitHub
transport ignores cancellation. The signal is checked again immediately before
each durable receipt confirmation, including after asynchronous registry
refresh. A cancelled recovery cannot confirm a commit or push, cannot start a
second push, and does not imply that an in-flight remote GET stopped running.
The transport must be server-owned and GET-only.

Every in-lease `refreshReviewed` registry read is also independently bounded
(default 10 seconds; `refreshDeadlineMs` may be 100–60,000 ms). An initial
timeout releases the lease without changing a pending intent; a timeout after
local or remote attestation blocks confirmation and retains the uncertain
receipt. External cancellation interrupts the wait even if the registry
resolver ignores its signal. Late registry results are discarded and cannot
confirm a receipt. The trusted registry refresh callback **must be read-only
and side-effect-free**: a deadline cannot terminate underlying JavaScript
work, so it must never contain a Git write, journal mutation or remote write.
This prevents a stalled registry dependency from indefinitely monopolizing
the shared repository lease; it does not replace host-level process isolation.

This is an additional **read-only recovery primitive**, not a startup hook,
HTTP route or automatic Git executor. Existing startup recovery still only
marks interrupted intents uncertain. A trusted operator-controlled recovery
workflow, independent security review, real target-host concurrency/crash tests
and all remaining issue #58 gates are required before production activation.

## Bounded, operator-controlled transfer recovery (issue #58)

The server-only `recoverUnresolvedGitTransfers` coordinator enumerates **distinct**
unresolved workspace IDs using stable keyset pagination (maximum 100 per
batch). It resolves each workspace through a trusted registry callback and
calls the existing read-only reconciliation under the shared repository lease.
Missing registry records, revoked sessions, foreign SQLite journals, malformed
or throwing registry bindings, mismatched workspace identities and lease
contention are reported as blocked/unavailable
without deleting, replacing or fabricating any intent. One blocked workspace
does not prevent inspection of subsequent workspaces; the cursor prevents
permanent starvation of later entries.

Registry lookups are bounded independently (default 10 seconds, configurable
between 100 ms and 60 seconds). A stalled or throwing resolver is reported as
blocked and cannot prevent later workspaces from being inspected. A lookup
that finishes **after** its deadline cannot begin reconciliation or mutate the
journal: the only operation raced against the timer is trusted registry
resolution, which happens **outside** the Git lease. Never apply a promise
timeout around lease-protected reconciliation itself: abandoning that promise
would release the lease while background journal writes could still execute.
A timed-out registry resolver may continue running in the background; it must
remain side-effect-free and must never perform Git, journal or network writes.

The coordinator is **not** an automatic startup task or HTTP endpoint.
A privileged operator must supply a fresh, server-owned registry resolver,
synchronous authorization, and read-only GitHub credentials. Cursor paging
must be resumed explicitly; a completed batch is not evidence that all
workspaces were recovered. Per-workspace outcomes must be audited without
logging tokens. A failed or ambiguous GitHub GET cannot authorize a new
commit, push or PR POST.

### Cross-workspace Draft PR ownership guard (2026-10-25)

The final `DeliveryGitTransferJournal.assertReadyForDraft` gate now refuses
publication when **any** other workspace has an existing commit or push record
for the same immutable operation key **or** the same GitHub destination and
managed branch. This includes `intent`, `uncertain` and `confirmed` records:
a crash, abandoned workspace, or competing operator cannot silently adopt the
same branch by supplying a different workspace ID or review fingerprint.
The check is read-only and does not delete or rewrite conflicting journal rows.
A conflict requires trusted operator investigation, not automatic cleanup.

This is a **final Draft PR eligibility defense**, not a substitute for
per-workspace Git lease serialization or a unique constraint on future transfer
intent creation. Existing recovery fixtures intentionally exercise multiple
unresolved workspaces; commit/push execution remains disabled pending an
independent review of cross-workspace ownership at _intent reservation time_.
The final guard must be invoked under the shared repository lease by the
trusted session-bound Draft PR executor; it is not a browser-accessible API.

Still required before activation: actual multi-process target-host crash
tests, a trusted registry/startup integration, independent receipt/security
review, and separate least-privilege write authorization. Do not treat
read-only recovery as approval to retry any remote write.
