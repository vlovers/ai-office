# Delivery startup recovery coordinator

Status: **unreleased, server-only integration**. This is not a production
startup hook, authenticated endpoint, commit/push implementation or deployment.

## Why a separate coordinator exists

A process restart may leave a publication reservation, commit intent or push
intent with an unknown external outcome. The legacy global
`DeliveryJournal.recoverInterrupted()` changes every reservation and is unsafe
when another publisher is active. Recovery must instead identify the exact
registered workspace and operation, then acquire the **same common-Git-dir
lease** used by publication.

`recoverRegisteredDeliveryWorkspaces` accepts a trusted, server-owned list of
registered workspaces plus the existing SQLite journals. It reads unresolved
publication and transfer rows, sorts workspace IDs deterministically, and
checks that every unresolved row has one unambiguous registration. It rejects
missing registrations, duplicate workspace IDs, mismatched operation keys,
foreign transfer identities and push stages without a matching confirmed
commit receipt **before any recovery transition**.

For each validated workspace it invokes
`recoverDeliveryWorkspaceWithTransfers`, which revalidates both Git
worktrees and common repository ownership while holding the shared lease.
Interrupted states become `uncertain`; confirmed receipts and unrelated
workspaces are preserved. No Git write, network call, external retry, branch
cleanup or journal deletion occurs.

## Operational contract

- The registration list must originate from the server's persisted,
  independently validated workspace registry. **Never** accept a browser
  supplied list, path, operator identity or repository metadata.
- Run only after the metadata database is opened and before accepting any
  publication requests. The server must retain its own metadata startup lock.
- An unregistered unresolved journal row is a hard startup error; inspect the
  persisted workspace metadata rather than skipping or deleting the row.
- A lease conflict or changed worktree identity stops the batch. Earlier
  transitions may already be `uncertain`; repeating the coordinator is
  idempotent and never retries an external write.
- The read-only inventory is not a cross-process global transaction. The
  production bootstrap must ensure a stable trusted registry and prevent
  concurrent metadata mutations while enumerating. Shared repository leases
  protect each actual recovery transition.
- `uncertain` is **not success**. Subsequent remote reconciliation must use
  independent GET-only evidence and exact SHA/PR identity checks.

## Validation and remaining gates

Integration fixtures cover two workspaces, stable ordering, duplicate and
missing registrations, stale operation/foreign transfer identity, foreign Git
worktree, held shared lease and SQLite close/reopen. Existing transfer and
publication tests cover receipt replay and remote API failure cases.

Before production activation: connect the trusted workspace registry to
startup; test two independent processes with real SQLite files and shared Git
worktrees; add separate authenticated commit/push approvals, Origin/CSRF/session
checks and least-privilege credentials. Keep all remote write HTTP routes
disabled until those gates and full CI pass.
