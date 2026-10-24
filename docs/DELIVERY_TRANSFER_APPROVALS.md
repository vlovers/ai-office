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
5. Consume the approval **before** the external operation. Record a durable
   stage intent **before** invoking Git or GitHub; neither operation may run
   without both conditions satisfied. If either local persistence step fails,
   stop without performing the external operation.
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

## Failure matrix

| Event                                                 | Required behavior                                  |
| ----------------------------------------------------- | -------------------------------------------------- |
| Approval belongs to another operator/session/stage    | Reject without external write                      |
| Review snapshot, destination, branch or SHA changed   | Reject; require fresh review                       |
| Approval expired, revoked or already consumed         | Reject; no replay                                  |
| Clock moves backwards across restart                  | Reject until trusted clock catches up              |
| Another process consumed approval                     | Atomic SQL update rejects second caller            |
| Crash after approval consumption, before intent       | No external write; manual recovery                 |
| Crash after intent, before or during external write   | Preserve uncertain state; read-only reconciliation |
| GitHub timeout, rate limit, 5xx or malformed response | Do not infer success or retry blindly              |
| Remote ref does not match reviewed SHA                | Do not confirm receipt                             |
| Existing publication has a different operation key    | Reject; never overwrite another workspace          |

## Tests and activation gates

The tests cover stage separation, identity mismatches, one-use consumption,
expiration, revocation, persistent clock rollback, independent SQLite
connections and restart recovery. This is not a substitute for cross-process
native Git integration tests, credential isolation, authenticated HTTP tests
and a production startup coordinator.

No UI endpoint, background publisher, credential exchange, automatic
commit/push, force push, reset, branch deletion or deployment is enabled here.
