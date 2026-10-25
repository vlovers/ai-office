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

**Intent-time ownership is now enforced atomically by SQLite triggers.**
Before a new commit/push intent is inserted, SQLite rejects any other workspace
that already owns the exact operation key or the same GitHub repository
(case-insensitive) and managed branch (case-sensitive). The check and insertion
execute inside SQLite's writer serialization, so independent Node processes
cannot both reserve a colliding identity. Identity-column UPDATEs also reject
cross-workspace collisions. This is an additional durable database boundary,
not a substitute for the shared repository/worktree Git lease, fresh registry
attestation or independent session authorization.

**Additional SQLite integrity triggers** now require a new transfer row to
start as a receipt-free intent, freeze its workspace, stage, operation,
destination, branch and reviewed head/base SHAs, and permit only monotonic
intent → uncertain → confirmed receipt transitions. A confirmed receipt
cannot be downgraded, replaced or silently reissued with another SHA, even
through a separate SQLite connection or Node process. These triggers guard
accidental direct-SQL writes as well as journal API calls; they are not proof
that a receipt was independently attested. Existing malformed legacy rows
remain intact and must fail closed during reconciliation. Test fixtures that
model pre-upgrade corruption explicitly remove the new trigger before
injecting an invalid row. Production migration must never do that.

**Cross-stage SQLite enforcement (2026-10-25):** new additive triggers
require a confirmed, exact-identity commit receipt before _any_ push intent
insertion or push receipt confirmation, including direct SQL from another
process. Direct deletion of any commit/push intent or receipt is rejected to
prevent an ambiguous operation being erased and replayed. The checks cover
workspace, operation key, destination, managed branch and reviewed head/base
SHAs; they do not independently attest Git or authorize a remote write.
Pre-upgrade orphaned or malformed push rows remain intact for manual audit,
and the application-level reconciliation/readiness gates still reject them.
Never drop these triggers or delete journal records as an automated recovery
strategy. An offline, reviewed data-repair procedure is a separate future gate.

The triggers are additive and do not delete, rewrite or silently adopt legacy
conflicting rows. On upgrade, the final `assertReadyForDraft` read-only gate
still blocks any old collisions; an operator must investigate them without
automatic cleanup. Recovery fixtures intentionally retain pre-upgrade
collisions to test that they remain discoverable. This does **not** authorize
commit, push or Draft PR POST; remote writes remain disabled. Independent
security review of the triggers, database migration, multi-process races and
the trusted session-bound executor is still required before activation.

Pre-upgrade ownership conflicts are also rejected by read-only commit/push
reconciliation **before** it changes an intent, and checked again after local
Git attestation and after GitHub GETs, immediately before either receipt is
confirmed. If a conflicting legacy row appears during an asynchronous read,
the pending receipt stays uncertain and no further remote write is attempted.
This closes a recovery-only gap without modifying legacy rows. The final Draft
PR ownership check remains mandatory, and trusted operators must investigate
collisions rather than replaying or deleting intents.

Still required before activation: actual multi-process target-host crash
tests, a trusted registry/startup integration, independent receipt/security
review, and separate least-privilege write authorization. Do not treat
read-only recovery as approval to retry any remote write.

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

## Publication Journal SQLite invariants (combined integration PR #79)

The `DeliveryJournal` constructor now installs additive SQLite indexes/triggers
without rewriting existing rows. Every SQLite connection, including a separate
Node process, rejects publication intents inserted directly as `published` or
`uncertain`, receipts attached to a new reservation, changes to a reserved
workspace/operation identity, receipt downgrade or replacement, deletion, and
a second workspace claiming the same publication operation key. Both publication
and commit/push journals also reject SQLite `INSERT OR REPLACE` against an
existing row: with default `recursive_triggers=OFF`, `REPLACE` can otherwise
silently delete a durable receipt without firing a DELETE trigger.

Valid `reserved -> uncertain -> published` recovery remains supported, but
an uncertain attempt **never authorizes another GitHub POST**. A pre-upgrade
database containing multiple owners for the same operation is preserved
verbatim and refused on read until a separately reviewed offline resolution.
These SQL constraints protect durability; they do **not** prove that a GitHub
receipt is genuine. The independent remote PR detail GET, exact commit SHA
comparison, live session/grant checks and shared Git lease remain mandatory.

Migration: stop all publishers, back up the private SQLite database together
with its WAL/SHM files, deploy the new binary, and inspect legacy conflicts
before any remote write. Never delete a journal row to unblock publication.
Rollback must not restart an older writer that can bypass these new triggers
until its safety is independently assessed. This change does not enable a
production GitHub credential, browser write endpoint, auto-merge or deploy.
Independent security review and target-host crash/restart tests are still
required.

## GitHub JSON response bounds (PR #79 hardening)

The Draft PR adapter, exact ref attestation, PR detail reconciliation and
complete open/closed PR inventory now parse upstream JSON through a shared
streaming byte-limit boundary: 256 KiB per ref, 1 MiB per PR detail or Draft
POST receipt, and 8 MiB per PR listing page. Limits apply to bytes actually
received, not only untrusted Content-Length; malformed UTF-8, JSON, empty
bodies, endless streams and oversized bodies fail closed. Existing request
deadlines bound stalled reads. Parser errors never echo remote response text.
An ambiguous POST response remains an uncertain journal entry; the size limit
never authorizes a second POST. The separately scoped read-only credential adapter now applies the
same per-endpoint limits (256 KiB refs, 1 MiB detail, 8 MiB inventory) before
forwarding sanitized JSON to the downstream parser. Previously its blanket
1 MiB cap could block valid complete PR inventories. Both layers count actual
bytes and reject invalid UTF-8; neither awaits cancellation of an untrusted
stream, because a hostile cancel handler may never resolve. HTTP errors and
credential echoes still fail closed without exposing tokens. These are
read-only transport safeguards, not permission to retry an ambiguous write.
Target-host validation and independent security review are still required
before enabling remote writes.

## Credential-scoped GitHub GET lifecycle (combined PR #79)

The server-only read credential facade now bounds the **entire** read lifecycle,
including asynchronous credential resolution, the upstream fetch and streaming
response-body parsing. A trusted server config sets a 10-second default
deadline (100 ms–60 seconds); the caller's AbortSignal can stop the wait
earlier. An injected provider or fetcher that ignores cancellation cannot hold
a shared Git lease indefinitely. A result arriving after the deadline cannot
advance the durable credential clock, quarantine a token, or return a response
to the caller. The underlying JavaScript promise may still run: injected
credential providers and transports must not perform unrelated writes.

The live operator authorization callback is required to be **synchronous**.
It is checked after vault resolution, immediately before GET, and again after
the complete bounded response body, before the response is returned to the
receipt parser. A grant revoked during transport or streaming therefore blocks
the result. An async/thenable authorization hook fails closed instead of
allowing a future authorization decision to race with a network request.
401/403 responses received within the deadline still durably quarantine the
credential version; errors never include upstream bodies or tokens.

The credential facade must forward GitHub's `Link` header for authenticated
PR inventory responses. The downstream parser validates its exact repository,
query, page sequence and completeness; stripping the header can incorrectly
treat a short page as the end of the inventory and miss an existing PR.
Malformed, cross-repository, overlong or credential-echoing pagination metadata
must fail closed. A linked second page returning 429/5xx is not a complete
inventory and must never authorize a Draft POST.

Read credential validity is checked again after the response stream completes:
the credential must not have been revoked, its expiry must still exceed the
five-second safety margin, and the observed clock must not roll back behind a
concurrent request's durable clock. These postflight checks supplement (rather
than replace) the synchronous operator grant check. In-flight revocation and
expiry must not yield an accepted GitHub ref or PR receipt.

These tests use controlled hung vault, transport and streaming implementations,
caller cancellation, late HTTP responses, and live-grant revocation. They are
not substitutes for target-host credential/HTTP crash tests or an independent
security review. Production remote writes remain disabled.

## Transfer receipt local-state TOCTOU revalidation (combined PR #79)

Read-only commit/push reconciliation now repeats the full local Git worktree
attestation immediately before persisting each durable receipt. The first
attestation verifies the reviewed branch, clean index/worktree, common Git
repository, exact head/base commits and credential-free origin. The second
attestation runs after the asynchronous trusted registry refresh for a commit,
and after both GitHub ref GETs and the final registry refresh for a push.

This closes a gap where a non-cooperating local Git process could dirty the
worktree, change origin or move refs while a remote GET or registry lookup
yielded the event loop. A late mutation leaves the corresponding intent
uncertain, without a second commit, push, Draft PR POST or journal deletion.
After an operator independently restores the exact reviewed local state,
read-only reconciliation may confirm the original intent using fresh evidence.

The shared lease serializes cooperating AI Office processes; it cannot
atomically exclude unrelated Git clients. Reattestation narrows the race but
does not make filesystem reads and SQLite writes a single transaction.
Native target-host crash and external-Git race testing, independent security
review and separate authenticated remote-write approvals remain mandatory.

## Draft PR final local-state revalidation (combined PR #79)

The server-only session-bound Draft PR executor now reattests the reviewed
local Git worktree **after** the final remote head/base ref GET and trusted
registry refresh, immediately before the one-attempt POST adapter. This
closes the asynchronous window in which a non-cooperating Git process could
dirty the index, move a ref, or change origin after the earlier pre-POST check.
A late failure leaves the already-reserved publication uncertain; it never
triggers a second POST or releases consumed approval evidence.

A second local attestation runs after the independent PR detail GET and
registry refresh, before persisting a published receipt. The same check
applies to read-only reconciliation of an ambiguous POST: matching GitHub
PR metadata alone cannot confirm a local operation if its reviewed Git
identity has drifted. Tests cover late drift during final ref GET, after a
completed POST during detail GET, and during reconciliation of an ambiguous
POST. Recovery requires restoration of the exact reviewed state and fresh
read-only PR inventory/detail evidence; it must not replay the POST.

These checks narrow time-of-check/time-of-use windows, but cannot make
external Git mutation and remote HTTP writes atomic. This remains a
server-only, unreleased boundary: production write routes, automatic retry,
merge and deployment are disabled pending independent security review,
target-host crash/race testing and least-privilege credential validation.

## Draft PR inventory-to-reservation review gate (combined PR #79)

A complete GitHub PR inventory is an asynchronous preflight, not an
authorization to consume the operator's one-use approval. After enumerating
and rejecting matching or conflicting PRs, the orchestrator refreshes the
trusted publication plan again. The session-bound adapter additionally
rechecks the actual local Git worktree, origin and reviewed commits, refreshes
the full trusted workspace registry, and repeats local attestation before
the SQLite approval consumption and publication reservation.

If a non-cooperating Git process dirties the worktree or changes origin
during PR inventory, or if the trusted registry changes, the operation fails
**before** creating any journal reservation or consuming approval. After the
operator restores the reviewed state, the same unused approval may be
retried. Once a reservation has committed, the existing no-blind-retry and
uncertain-outcome rules still apply; the pre-reservation gate does not turn
ambiguous remote writes into retryable operations.

The tests exercise both real Git mutations and registry drift injected
during inventory, asserting zero POSTs, no durable reservation and a
successful retry only after restoring the original reviewed state.
External Git mutation is not atomically locked; the final pre-POST and
post-detail attestations remain necessary. Production writes stay disabled
until independent security review and target-host validation.

## Ambiguous Draft PR managed-head ownership (combined PR #79)

Read-only recovery now applies the same conservative managed-head ownership
policy as preflight. A single matching open Draft PR is **not** sufficient
evidence if another open or closed PR uses the reviewed managed head branch,
even when the other PR targets a different base branch or comes from a fork.
The full `state=all` inventory must contain exactly one PR using that head
before the independent PR-detail SHA check can confirm the SQLite receipt.

On conflict, the publication journal stays `uncertain` with no stored PR
URL. The original one-use approval remains consumed and recovery never sends
another POST. Operators must investigate all matching-head PRs, including
closed records, and establish unique ownership using a fresh complete
inventory; do not delete SQLite rows or manually mark a receipt published.
Unrelated PRs on other heads do not block legitimate recovery.

Regression coverage includes pure reconciliation for open, closed and forked
conflicts; SQLite orchestration after an ambiguous POST; and the full
session-bound GitHub adapter across a second SQLite connection/restart.
This is defense in depth, not permission to enable remote write credentials.

## Mandatory approved Draft publication gates (combined PR #79)

The authenticated `createApprovedDraftPublication` composition now requires
both `verifyBeforeReserve` and `verifyRemoteReceipt` callbacks at the
TypeScript boundary **and** checks them at runtime before any authorization,
inventory, journal mutation or remote call. This prevents a trusted but
misconfigured caller from consuming one-use approval after asynchronous
inventory without a final reviewed-snapshot check, or adopting a PR from
inventory/POST metadata without an independent detail/commit-SHA check.

A failed final snapshot check leaves approval unused and creates no journal
reservation. Once a POST attempt is reserved, a failed independent PR-detail
check leaves the operation uncertain and consumed; subsequent recovery is
read-only and must pass the same independent verification. The session-bound
GitHub adapter supplies real local/registry and remote SHA verifiers. Test
stubs in the generic composition tests are not production attestation.

This does not make the generic `createDraftPublication` test harness a safe
production writer: only the authenticated, server-owned composition may be
considered for future activation, after independent review and target-host
validation. No HTTP write route or production credential has been enabled.
