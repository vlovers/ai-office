# Registry-backed Delivery startup recovery

Status: **server-only unreleased recovery foundation**. This does not create a
GitHub PR, commit, push, authenticate an operator, enable a browser write route
or schedule any external retry.

## Why a coordinator is required

The Delivery Journal and Git transfer receipts survive crashes, but a
`reserved` publication or `intent` transfer cannot be treated as a failed
external operation. The remote write may have succeeded. The startup
coordinator `recoverRegisteredDeliveryOperations` discovers unresolved
operations in **both** SQLite journals, resolves each workspace from a trusted
server-owned registry, and runs scoped recovery under the same Git common-dir
lease used by publication.

It never calls the legacy global `recoverInterrupted()` SQL update, never
replays Git or GitHub operations, and never deletes existing approvals,
receipts, branches or worktrees.

## Fail-closed conditions

- Missing or throwing registry resolver: the workspace is blocked unchanged.
- Multiple operation keys for one workspace: block before resolving paths or
  touching either journal.
- Registry workspace or operation identity mismatch: block unchanged.
- Stale/foreign repository or worktree, shared lease contention, or recovery
  validation failure: block unchanged.
- Valid workspace: only its interrupted `reserved` / `intent` states become
  `uncertain`; confirmed and published receipts are preserved.
- A blocked workspace does not prevent another independently registered
  workspace from recovering. Results are sorted by workspace ID.
- Error details are intentionally reduced to safe reason codes; raw exception
  messages can contain private local paths.

The registry resolver **must** be backed by authenticated, server-maintained
workspace records. Journal rows alone never authorize filesystem paths or
remote actions. Do not feed browser-provided paths or operation identities into
this function.

## Tests and deployment boundary

Native Git + SQLite integration tests cover two workspaces, conflicting
operation keys, missing registration, lock contention, confirmed commit with
interrupted push, idempotent repeat recovery and process restart.

This module is an explicit orchestration primitive, **not** a startup hook.
Production wiring still requires verified registry discovery, safe credential
storage, authenticated operator sessions, Origin/CSRF checks and native
cross-process acceptance tests before any write UI can be enabled. Uncertain
GitHub outcomes require independent read-only reconciliation; no automatic
retry is permitted.
