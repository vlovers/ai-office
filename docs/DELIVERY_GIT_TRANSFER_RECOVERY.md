# Delivery Git transfer receipts and scoped recovery

Status: **unreleased server-only foundation**. This code does not commit, push,
create a GitHub PR from an HTTP request, authenticate an operator or enable
automatic remote writes. No migration deletes existing journal data.

## Durable state and identity

`DeliveryGitTransferJournal` creates a separate SQLite table for the local
commit and remote push stages. Each workspace/stage has exactly one immutable
intent, bound to the publication operation key, canonical GitHub destination,
managed branch and exact reviewed head/base SHA pair. Duplicate or conflicting
reservations are rejected even after a restart.

The states are:

- `intent`: a stage was durably reserved; its external outcome is not proven.
- `uncertain`: the stage was interrupted or its outcome is ambiguous. **Never
  replay the external operation** from this state.
- `confirmed`: a trusted server caller independently checked the exact SHA
  and persisted a receipt.

Push intent requires a matching confirmed commit receipt. Draft PR eligibility
requires both independently confirmed receipts with the same immutable identity.
The stronger `publishReceiptedLocallyAttestedOperatorDraftViaGitHub` entrypoint
checks both receipts **inside the existing shared Git lease**, after local Git
attestation and before any GitHub GET, operator approval consumption, journal
reservation or POST. Existing lower-level server-only functions are not public
authorization endpoints and must not be wired to a browser.

## Verification and crash safety

`verifyDeliveryGitTransfer` acquires the same common-repository/worktree lease
as publication and runs an injected **read-only** verification callback before
persisting the exact SHA. The callback must be trusted server code: for a commit,
check the local commit object and reviewed worktree; for a push, fetch the exact
GitHub ref and validate the repository/branch/object type and SHA. A callback
returning an arbitrary SHA is **not** proof of authenticity. GitHub 403, 429,
5xx, incomplete pages, malformed responses, timeouts and mismatched refs must
leave the stage unconfirmed. Never infer remote success from a timeout.

`recoverDeliveryWorkspace` replaces unsafe global startup recovery for a
specific publication operation. It acquires the **same** repository lease,
revalidates both registered Git worktrees and their common Git directory,
then atomically moves only that operation's `reserved` row to `uncertain`.
Other workspaces are not modified. The transfer journal has a matching
per-stage `recoverWorkspace` transition, which must also run under that lease.
A lock held by another process fails closed; stale locks are not stolen.
`DeliveryJournal.recoverInterrupted()` remains for legacy single-process
maintenance only and **must not be called while any publisher can run**.

No automatic retries, force-push, branch deletion, reset, merge, deployment or
remote mutation are introduced. SQLite intent and receipt records are
monotonic; recovery does not erase them. Rollback may leave the new table
unused, but it must not discard or rewrite existing receipts.

## Outstanding production gates

This stage is a **partial implementation of issue #58**, not production
activation. Before any authenticated UI action can initiate commit/push:

1. Bind separate one-use commit/push approvals to trusted server sessions and
   reviewed tree/head/base SHAs, not client-provided identity.
2. Implement a concrete least-privilege read-only GitHub push-ref verifier with
   strict response validation and ambiguity handling; no token in logs.
3. Serialize *all* startup transfer/publication recovery per workspace and
   verify multi-process SQLite behavior across actual independent processes.
4. Establish Origin/CSRF/session authorization, credential boundaries, and
   independent end-to-end browser/native tests.
5. Do not expose any write endpoint until all checks and CI are green.
