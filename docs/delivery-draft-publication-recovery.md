# Draft PR publication recovery

AI Office treats a Draft PR creation request as a **single external write**. A
network timeout, process crash, or unexpected GitHub response after the
durable SQLite reservation must never trigger another POST for the same
publication operation.

## Durable states

- **No journal row:** No durable reservation exists. Repeat the normal
  authenticated preflight with a valid one-use approval.
- **`reserved`:** The approval and write intent were committed, but the remote
  outcome may be unknown. Run startup recovery under the shared Git lease;
  never POST.
- **`uncertain`:** The remote outcome has not been independently established.
  Use read-only GitHub inventory and receipt verification.
- **`published`:** A commit-pinned PR receipt was verified and recorded.
  Revalidate the remote receipt on reuse; never POST.

An HTTP error does **not** prove that GitHub rejected the POST. A missing PR
in a single list response does **not** authorize a retry.

## After a process crash

1. Stop new publication attempts and identify the affected workspace,
   operation key, repository, Git worktree and SQLite database.
2. Inspect the shared Git lease owner metadata (`owner.json`) for the
   canonical Git common directory and worktree. Check the recorded PID,
   timestamp and owning AI Office instance. Confirm that the original process
   and its descendants have exited and that no other worker is using the
   repository. **Never automatically steal or delete a lock.**
3. Only after explicit operator verification, clear the specific stale
   test/production lease using the deployment's controlled maintenance
   procedure. Do not delete unrelated locks or repository data.
4. Preserve the SQLite database and its WAL/SHM files. Make a consistent
   backup using SQLite's backup mechanism when appropriate; do not reset
   approvals, delete journal rows or manually change `uncertain` to
   `reserved`.
5. Run the trusted startup recovery under the same repository lease.
   `reserved` becomes `uncertain` without issuing a GitHub POST.
6. Perform a complete read-only GitHub inventory of **open and closed**
   pull requests, including all pages. Fail closed on pagination drift,
   rate limits, authentication failures, timeouts or malformed responses.
7. Require a unique PR with the reviewed managed head and base, then fetch
   its details independently. Verify repository identity, draft status,
   branch identities and the exact approved head/base commit SHAs. Recheck
   the local Git snapshot, operator authorization and trusted workspace
   registration before committing the receipt.
8. Only a uniquely verified receipt may transition the journal to
   `published`. Missing, duplicated, conflicting or unverifiable candidates
   leave the operation `uncertain` for investigation.

If the lease remains held, recovery must stop. If GitHub is unavailable,
recovery must stop without changing a remote repository. Do not issue a new
approval to bypass an uncertain operation.

## Regression coverage

- `tests/delivery-draft-post-crash-process.test.ts` simulates a child
  process killed immediately after the only fake remote POST, verifies that
  the stale shared lease blocks another process, and exercises incomplete
  inventory, rejected receipt, successful reconciliation and repeat reuse.
  Its explicit lock cleanup applies **only to its isolated temporary Git
  repository** after verifying the child PID is no longer running.
- `tests/delivery-startup-recovery-process.test.ts` verifies the startup
  coordinator cannot steal a live Git lease and that recovery is idempotent.
- `tests/delivery-publication-sqlite-integrity.test.ts` verifies journal
  invariants across process boundaries and direct SQL attempts.

These tests use local fixtures. They do not create GitHub pull requests.
