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

The operator-driven sweep also accepts an `AbortSignal` and a monotonic
`batchBudgetMs` (default 60 seconds, allowed 100 ms–10 minutes). This is a
**soft budget**, not a promise timeout around a held Git lease. The coordinator
limits each trusted registry lookup to the smaller of its own timeout and the
remaining batch budget, rejects late resolver results, and stops starting new
workspaces when the budget is exhausted. An operator abort interrupts a pending
registry lookup and propagates to the active read-only GitHub reconciliation,
which must finish its own lease-protected cleanup before the batch returns.

A stopped batch returns `stopReason` (`aborted` or `budget-exhausted`),
`hasMore: true`, and `nextCursor` pointing to the **last processed**
workspace (or the input cursor when none was processed). A workspace whose
registry lookup was interrupted, whose in-lease reconciliation was cancelled
by either the operator or its trusted per-workspace transport, or whose
reconciliation completed after the soft budget expired is never skipped by
the resume cursor, even if its blocked outcome is reported. In-lease work is
allowed to settle under the shared Git lease before the coordinator checks
the budget and cursor. Resume explicitly from the returned cursor with a new
authorized call; the same workspace may be visited again, and durable
confirmed receipts must remain idempotent. A normal completed page reports
`stopReason: null`; its original keyset cursor semantics remain unchanged.
No new Git intents, remote writes or automatic retries are permitted.

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

### Receipt confirmation: final read-only revalidation (PR #79)

The shared `createDraftPublication` orchestrator now requires an independent
`verifyRemoteReceipt` callback even for its generic server-side entry point.
A GitHub PR list entry, an unverified POST body, or a stored URL cannot by itself
confirm a publication. Missing verification is rejected before acquiring a lease,
reserving an approval, or contacting GitHub.

After the independent detail GET, the orchestrator refreshes the approved
publication plan and re-runs the trusted snapshot verifier **under the same
repository lease**, immediately before `publish` or `confirmUncertain`.
This applies to successful POSTs, ambiguous-write reconciliation, and already
published receipt reuse. If the plan changes or the snapshot check fails after
a remote request, the local reservation stays uncertain; an already published
row is left intact and reuse is refused. Neither outcome permits another POST.

The final verifier must be read-only, server-owned, and capable of checking
exact Git commit identities. This is a defense against registry and Git drift
during asynchronous remote receipt reads, **not** a guarantee that a remote
request and local authorization revocation are atomic. Independent security
review and target-host tests remain required before production activation.

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

## Independent-process Draft PR POST crash boundary (combined PR #79)

The real session-bound Draft PR composition is now exercised in an independent
Node process against a real temporary Git repository and a file-backed SQLite
database. The test worker authenticates with a persisted operator session,
passes the verified commit/push transfer receipts, consumes its one-use
approval, commits the publication reservation, enters the one-attempt GitHub
POST adapter, and is forcibly terminated with `SIGKILL` before a local
publication receipt can be written. A controlled fake GitHub transport records
whether the remote side accepted the POST outside the Git worktree.

The killed worker intentionally leaves the shared filesystem lease behind.
Restarted operations initially fail with `Resource is locked`; the application
**must not** automatically steal this lease. In the test only, the harness
verifies that the `SIGKILL` child has exited and that every lock owner PID and
lock detail belong to this exact temporary repository, then simulates explicit
operator lease cleanup. This cleanup is not an application recovery API and
must never be used against arbitrary production locks.

A new SQLite connection and session service then recover the persisted
`reserved` intent, after the verified-dead test lease has been cleared. The matrix covers:

- Crash before remote acceptance: no matching PR exists, so recovery remains
  `uncertain` and **never retries POST**.
- Crash after remote acceptance: complete read-only PR inventory plus an
  independent PR-detail GET verifies the exact head/base SHAs and records
  `published`, without another POST.
- Rate-limited first recovery inventory (HTTP 429): preserve uncertainty;
  a subsequent authorized read-only reconciliation may confirm the receipt.
- Two PRs reusing the managed head: refuse ambiguous ownership until the
  inventory is independently resolved; do not fabricate or overwrite a URL.
- Revoked operator grant or changed real Git worktree after restart: block
  recovery before GitHub access or journal confirmation; allow a fresh
  read-only reconciliation only after restoring authorization and Git state.

These are **controlled fake-transport crash tests**, not a live GitHub
failure-injection campaign. The test does not prove that a real remote service
committed a POST just before a TCP disconnect, that all filesystem durability
conditions hold on the deployment host, or that credential provisioning is
production-safe. The SQLite intent and receipt remain non-deletable evidence;
there is no automatic replay of an ambiguous remote write.

Production GitHub writes, merge endpoints and automatic retries remain
disabled pending independent security review, least-privilege credentials,
target-host crash testing and operational sign-off.

## Post-write managed-head uniqueness gate (combined PR #79)

A successful GitHub Draft PR POST and independently verified PR detail are not
sufficient to persist a local `published` receipt: a different actor can create
a second PR using the same managed head after our preflight inventory but
before the write completes.

The session-bound publication adapter now repeats the **complete open/closed
GitHub PR inventory after the POST** and independently reconciles ownership.
Exactly one valid PR must own the managed head, and its canonical URL must
match the independently fetched detail. This also runs on receipt reuse and
ambiguous-result recovery, not just the initial success path.

- A second PR using the managed head (including a different base or fork)
  blocks confirmation. Neither a 201 response nor a valid PR detail overrides
  the conflict.
- HTTP 403/429/5xx, partial pagination, malformed responses and eventual
  inventory visibility gaps leave the reserved operation `uncertain`. A
  subsequent invocation may only perform read-only reconciliation; it cannot
  issue another POST or consume another approval.
- After the post-write inventory, revalidate the trusted registry, operator
  authorization, real local Git state and immutable commit/push receipts before
  the durable `published` transition. A local Git mutation during the
  additional remote GET leaves the journal uncertain.
- Tests cover conflicting PR ownership after a successful POST, a post-write
  HTTP 429, delayed inventory visibility and real Git drift during the final
  inventory. The existing SIGKILL/restart tests still prohibit a second POST.

This narrows the inventory-to-write race; it does **not** make GitHub's PR
inventory transactional. Independent security review, target-host crash tests,
least-privilege credential validation and explicit production activation
remain required. Production remote writes are still disabled.

## Cumulative GitHub PR inventory deadline (integration PR #79)

The read-only PR inventory now has a **60-second total monotonic budget**
(`inventoryDeadlineMs`, server-only, 100–60,000 ms), shared across all
open/closed pagination requests. Each page uses the smaller of its configured
request timeout and the remaining inventory budget; the budget is rechecked
after response parsing and before returning a complete inventory. A slow
repository cannot renew a full per-page timeout indefinitely while holding
the shared Git lease. No partial inventory is ever returned as complete.

The same budget applies independently to preflight discovery and post-write
ownership verification in the session-bound Draft PR executor. If preflight
exceeds the budget, the approval remains unconsumed, the journal is not
reserved and **no POST** occurs. If post-write verification exceeds it, the
existing reservation stays `uncertain`; later recovery may only perform
GET-based verification, never another POST. Unit and session-bound SQLite
integration tests cover both boundaries and safe read-only recovery.

This deadline is **not** proof of atomic GitHub inventory or permission to
retry an ambiguous remote write. Real-host timing, network failure injection,
credential scoping, independent review and manual activation remain required.

## Bounded trusted registry refresh under Git lease (integration PR #79)

The session-bound Draft PR executor now bounds every asynchronous trusted
workspace registry refresh to 10 seconds by default (`refreshDeadlineMs`,
100–60,000 ms), with a separate 60-second monotonic attempt-wide budget
(`refreshBudgetMs`, 100–60,000 ms). The shared budget is checked before
each refresh and again after its result; a slow GitHub inventory cannot
silently renew the registry budget. Cancellation is observed independently
of a non-cooperating registry resolver. Timed-out, cancelled or late resolver
results are never used to approve a publication transition.

The failure boundary is intentionally asymmetric. Before the atomic
approval/reservation transaction, a hung registry fails closed with the
one-use approval intact and no Draft PR POST. After the transaction, the
durable journal remains `uncertain` even if no POST was sent, because a
restart cannot infer whether the remote write occurred. After a successful
POST, a stalled post-write registry verification also leaves the journal
`uncertain`; subsequent attempts use complete read-only GitHub inventory,
independent PR detail and reviewed snapshot checks, never another POST.

Integration coverage exercises initial and post-inventory hangs, a hang
after reservation, a hang after remote acceptance followed by GET-only
reconciliation, cumulative budget exhaustion, invalid deadline values,
and cancellation with a late registry result. This does **not** guarantee
that a non-cooperating resolver stops consuming external resources; it
guarantees only that its late promise result cannot authorize the GitHub
write or durable receipt. Native target-host validation and independent
security review remain required before any production activation.

## GitHub PR inventory identity and pagination drift (integration PR #79)

GitHub's paginated `state=all` pull-request listing is **not** a
transactionally consistent snapshot. Concurrent remote PR creation or deletion
can shift offset-based pages, repeat an earlier PR or hide another one. A
complete HTTP pagination traversal is not by itself evidence that no remote
publisher raced with the current attempt.

The read-only adapter now rejects any page containing a PR URL outside the
exact approved repository, a noncanonical PR URL, or a base repository
identity inconsistent with the requested repository. A forked **head**
repository remains representable for duplicate detection. The collector also
rejects repeated PR URLs within a page or across pages rather than silently
deduplicating an inconsistent inventory. Such responses are treated as
incomplete, never as permission to create or confirm a Draft PR.

Before the durable reservation, this failure leaves the one-use approval
unconsumed and performs no POST. After a POST, the reservation remains
`uncertain`; later calls may only reconcile through read-only GitHub GETs,
never replay the write. Integration tests exercise both paths and successful
GET-only recovery once a stable inventory is available.

**Residual race:** a shifted page can omit a PR without repeating another.
Neither this detector, the shared _local_ Git lease nor the post-write
uniqueness check provides GitHub-side atomicity. Before production activation,
run live disposable-repository concurrency tests, independently review the
remaining remote publication race and decide whether additional
server-side repository policy or an external coordination mechanism is
required. Production writes remain disabled.
