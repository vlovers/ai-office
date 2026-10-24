# Delivery publication pipeline — implementation and safety contract

Status: **unreleased server-side integration boundary, not a live GitHub publisher**.
The API and UI do not expose a write endpoint. No unattended commit, push, PR,
merge, branch deletion or deployment is enabled.

## Components

- `delivery-preflight.ts`, `delivery-confirmation.ts` and
  `delivery-publication-policy.ts` create a revision-bound, explicit operator
  publication plan. The plan alone does not authorize a remote write.
- `delivery-publication-coordinator.ts` computes a stable operation identity
  and blocks stale review snapshots.
- `delivery-publication-lease.ts` shares the repository/worktree lock namespace
  with normal AI Office Git mutations. It refreshes the plan **inside the lock**
  and passes the validated snapshot to the callback.
- `delivery-journal.ts` reserves the workspace in SQLite before a remote
  attempt; states are `reserved`, `uncertain`, and `published`. A workspace
  can have only one operation key. The journal persists no credentials.
- `delivery-publication-execution.ts` performs exactly one injected remote
  CREATE attempt after reservation. Any error or invalid receipt leaves the
  operation uncertain and blocks an automatic retry.
- `delivery-publication-receipt.ts` verifies the returned GitHub PR is an
  **open draft** with the exact head/base branches, exact head/base repository
  identities and canonical URL under the approved destination. Forked PRs
  with matching branch names are rejected.
- `delivery-publication-service.ts` composes the lock, fresh snapshot,
  journal, injected draft creation, receipt validation and read-only recovery.
  A repeated successful request reuses its validated local receipt.
- `delivery-publication-reconciliation.ts` compares remote candidates only
  for an already uncertain operation. An absent, duplicate, foreign, closed
  or non-draft PR cannot be treated as confirmation.

## Failure and restart matrix

| Situation | Durable state | Safe next action |
| --- | --- | --- |
| No reservation; plan stale under lease | absent | Re-review; no remote call |
| Reserved, GitHub returns verified draft | published | Reuse local receipt |
| Remote call times out or throws | uncertain | Read-only remote reconciliation |
| Remote response fails identity check | uncertain | Manual investigation |
| Crash after reservation | reserved on disk | Startup marks uncertain |
| Incomplete/failed remote listing | uncertain | No retry; investigate |
| One verified matching open draft | published after reconciliation | Reuse receipt |
| Two matching PRs or no matching PR | uncertain | Manual resolution |
| Conflicting workspace operation key | unchanged | Re-review and investigate |

The startup path must call `journal.recoverInterrupted()` **once before
accepting new publication work**. Do not call it per request: it would
incorrectly mark another active operation uncertain. Recovery is a read-only
GitHub inspection plus a conditional SQLite transition, never a second POST.

The injected remote-list adapter must exhaust **all pages of open and closed
PRs** for the exact repository and set `complete: true` only after successful
pagination. A partial list is not evidence of absence. Both publication and
reconciliation hold the shared Git lease while checking journal state and
current review snapshot.

## Verification

`tests/delivery-publication-service.test.ts` exercises SQLite-backed
reservation, one-shot remote calls, idempotent reuse, stale snapshots,
competing operations, concurrent callers, ambiguous failures, fork rejection,
complete/incomplete remote listings, duplicate results and an actual SQLite
close/reopen recovery path. Receipt/reconciliation tests cover additional
hostile remote responses. Run `npm run check` and `npm run format:check`,
plus the native sandbox and browser approval CI jobs.

## Production activation blockers

This layer deliberately injects `createDraft` and `listAllRemoteDrafts`
instead of embedding an authenticated GitHub API client. Before exposing a
production endpoint:

1. Implement independently confirmed, least-privilege GitHub auth and
   verified destination repository identity. Do not accept an arbitrary URL
   or GitHub token from a browser request.
2. Build separate, operator-confirmed **commit**, **push** and **draft PR**
   transitions. Persist each step's intent and receipt independently; do not
   collapse an ambiguous push into a retryable PR step.
3. Pin and revalidate the actual head/base Git commit SHAs, worktree ownership,
   and approved revision immediately before each write. Current review
   fingerprints are not remote commit SHA attestations.
4. Implement complete paginated remote discovery, with retryable read errors
   that never become a write retry. Validate immutable GitHub repository IDs,
   head commit SHA and exact PR ownership against an approved target.
5. Add authenticated HTTP request validation, CSRF/Origin controls, operator
   confirmation UI, read-only CI status and end-to-end browser/native tests.
6. Ensure multi-process startup recovery is serialized; do not run
   `recoverInterrupted()` while another live publisher may hold a reservation.

No automatic merging, force-pushing, deployment or destructive cleanup is
authorized by this module.
