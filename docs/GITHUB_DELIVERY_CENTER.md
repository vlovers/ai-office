# GitHub Delivery Center — staged implementation

This is an **unreleased read-only readiness slice**, not GitHub publishing.

## Implemented in this branch

- A delivery-readiness assessment adjacent to the live Code Review Center.
- Local gates: completed task, matching worktree, recorded ownership, no pending
  filesystem operation/recovery, explicit Keep decision, review revision, nonempty
  change list, and inspectable text changes.
- Manual gates are **always** displayed: commit, remote/permissions, and separate
  publication approval. Passing local gates is not permission to push.
- Pure assessment tests for stale, pending, recovering, rejected and unsafe states.
- Copyable local PR title/description draft, including review revision and source branch.
- Read-only POST /api/tasks/:id/delivery/preflight endpoint that reuses the
  existing server review operation and returns blocked/manual-review checks.
  It does not claim remote ownership, branch protection or commit readiness.
- Local-only GitHub remote URL/SSH classifier; rejects credential-bearing URLs,
  non-GitHub hosts, unsafe schemes, extra paths and control characters.
  The operator enters a remote manually; the app does not fetch repository remotes.

## Required for an actual publishing implementation

1. A **server-side** preflight under existing workspace/repository leases that
   revalidates canonical worktree identity, revision, branch HEAD, dirty index,
   nested repos, ignored files, remotes and target repository ownership.
2. A separate commit operation with a revision-pinned user confirmation and
   clear disclosure of which files will be staged. Never silently stage all files.
3. Minimal-permission GitHub authentication and explicit confirmation of push
   destination, branch, PR title/body and target branch. No token logging.
4. Durable operation intent and fail-closed restart recovery, with no automatic
   retries after ambiguous network or GitHub outcomes.
5. Read-only PR/CI status polling tied to exact commit SHA and clear error states.
6. Security and browser tests: stale revisions, remote mismatch, symlinks,
   concurrent mutation, credential leaks, denied approval, crash/restart.
7. No automatic merge, deployment, privilege escalation or background push.

## Boundaries

The current UI does **not** commit, push, create PRs, or query GitHub.
The preflight API is read-only and does not authorize any mutation.
The local checklist cannot establish remote access or guarantee a safe push.
