# Git transfer operator approvals (server-only)

Status: **unreleased foundation**. This module is not an HTTP authorization
mechanism and does not enable Git commit, Git push or Draft PR creation.

## Approval contract

`DeliveryTransferApprovalLedger` stores an independent, one-use approval for
each `commit` or `push` stage. The immutable binding includes the exact
workspace, publication operation key, canonical GitHub destination, managed
branch, reviewed head/base commit SHAs, trusted operator ID and trusted
session ID. A commit approval cannot authorize a push, even when all other
fields match. The approval ID is a random UUID, not an authentication token.

An approval may be issued only after a trusted server has authenticated the
operator, confirmed an explicit action-specific user decision, and independently
re-attested the current review snapshot. Neither an operator ID nor a session
ID supplied by a browser is proof of authentication.

The ledger uses SQLite conditional updates to consume each approval at most
once. An expired, revoked, consumed or mismatched approval fails closed. The
maximum lifetime is 15 minutes, with a five-minute default. A persisted clock
watermark prevents a backwards wall-clock jump from reviving old approvals.
Approval state survives process restarts and is shared across SQLite
connections using the same database file.

## Required execution ordering

A future trusted publisher must:

1. Authenticate the operator and enforce session, Origin and CSRF checks.
2. Acquire the shared repository/worktree Git lease before inspecting mutable
   Git state or consuming an approval.
3. Revalidate repository/worktree identity, the exact publication plan,
   clean reviewed tree and head/base SHAs under that lease.
4. Confirm the correct stage approval is pending and bound to that review.
5. Consume the approval and reserve the durable stage intent in **one**
   SQLite `BEGIN IMMEDIATE` transaction on the same database connection,
   while holding the shared repository lease. Either both changes commit or
   neither does. Never invoke Git or GitHub before the transaction commits.
6. Execute at most one authorized external operation. On timeout, crash,
   GitHub 403/429/5xx or ambiguous result, retain an uncertain stage; do not
   replay the operation automatically.
7. Independently verify the resulting local commit or exact GitHub remote ref
   under the same lease before recording a confirmed receipt. Draft PR
   publication requires both confirmed commit and push receipts.

Do not assume a successful HTTP response proves a push or PR was created.
Never infer success from a timeout. A restarted worker must reconcile
outstanding journal entries using read-only evidence; an approval must never
be regenerated automatically to retry an uncertain external operation.

## Leased transfer execution composition

`executeAuthorizedTransferStage` composes the shared repository lease,
refreshed publication snapshot, independently supplied local Git attestation,
stage-specific operator approval, **atomic** durable transfer intent, a single
trusted external operation and independent read-only receipt verification.
The executor requires one explicit `DatabaseSync` connection for both ledgers
and calls `reserveApprovedTransferIntentAtomically` under the held lease.
`reserveApprovedDeliveryGitTransfer` is a separate, server-only leased
reservation primitive with real worktree ownership checks; it does **not**
perform a Git operation and must not be used to execute one after its lease
has been released. A confirmed receipt requires the exact reviewed SHA. A push cannot start until the matching
commit receipt is confirmed. Duplicate requests, changed snapshots, expired
approvals, ambiguous HTTP responses and invalid receipts fail closed.

This is still **server-only**. The executor and local verification callbacks
must be supplied by trusted server code, never an HTTP request. No actual Git
commit, push, GitHub credential exchange, automatic retry, browser endpoint or
background publisher is registered by this module. A production integration
must authenticate the operator, verify repository/worktree ownership, bind
least-privilege credentials, implement secure Origin/CSRF controls and exercise
native cross-process tests before activation. In particular, callers must not
invoke an external operation after the shared lease has been released.

## Failure matrix

| Event                                                 | Required behavior                                  |
| ----------------------------------------------------- | -------------------------------------------------- |
| Approval belongs to another operator/session/stage    | Reject without external write                      |
| Review snapshot, destination, branch or SHA changed   | Reject; require fresh review                       |
| Approval expired, revoked or already consumed         | Reject; no replay                                  |
| Clock moves backwards across restart                  | Reject until trusted clock catches up              |
| Another process consumed approval                     | Atomic SQL update rejects second caller            |
| Crash during approval/intent transaction              | Both roll back; no external write                  |
| Crash after intent, before or during external write   | Preserve uncertain state; read-only reconciliation |
| GitHub timeout, rate limit, 5xx or malformed response | Do not infer success or retry blindly              |
| Remote ref does not match reviewed SHA                | Do not confirm receipt                             |
| Existing publication has a different operation key    | Reject; never overwrite another workspace          |

## Tests and activation gates

The tests cover stage separation, identity mismatches, one-use consumption,
expiration, revocation, persistent clock rollback, independent SQLite
connections and restart recovery. The atomic reservation tests additionally
exercise real temporary Git repositories, clean-snapshot attestation, foreign
worktree rejection, shared-lease contention, duplicate-intent rollback and
restart recovery. These do not replace authenticated HTTP tests, real remote
credentials, independent cross-process Git tests or a production startup
coordinator.

No UI endpoint, background publisher, credential exchange, automatic
commit/push, force push, reset, branch deletion or deployment is enabled here.
