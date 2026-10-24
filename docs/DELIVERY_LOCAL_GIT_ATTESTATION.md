# Local Git attestation for delivery (unreleased)

This is a **server-only, read-only gate**. It does not commit, push, create a
GitHub PR, authenticate a browser session or grant publication permission.
There is no new HTTP route.

## Scope

`attestLocalReviewedGitState(plan, review)` checks an independently reviewed
worktree and exact Git commit pair. It requires:

- An allowed revision-pinned publication plan for a managed `ai-office/*`
  branch targeting `main`.
- A worktree root and Git directory that pass existing repository identity
  revalidation, with the Git directory bound to the selected workspace.
- A completely clean tracked/untracked worktree and index (including
  submodule changes), an attached exact managed branch, and the approved
  `HEAD` and local `refs/heads/main` commit SHAs.
- A credential-free GitHub `origin` matching the approved destination.
- A second read of status, branch, both commits and origin to detect
  incidental changes during attestation.

All Git invocations go through the existing fixed-argument `repositories.git`
wrapper. No shell, Git fetch, checkout, reset, commit or push is performed.
Errors from Git subprocesses are replaced with a generic message to avoid
leaking credentials embedded in malformed remote configuration.

`publishLocallyAttestedDraftViaGitHub` composes this check with the
commit-pinned server-only publication adapter. The local check runs **inside
the shared Git lease**, before GitHub GET ref attestation, SQLite reservation
and the single remote POST. A failed check leaves the journal empty and
cannot create a remote PR.

## Trust boundary and remaining blockers

This check verifies the current local worktree, not the provenance of an
operator's approval. A trusted server session must independently authorize
the reviewed snapshot and each commit/push/publish transition. It is not
safe to expose the lower-level adapter as an HTTP handler.

The shared lease coordinates AI Office writers. An unrelated external Git
process is not required to honor that lease; the second read detects many
races but cannot prevent a malicious external writer from changing refs
immediately afterward. A production publisher must also verify that the
workspace belongs to the expected common Git repository, enforce verified
operator identity and CSRF/Origin policy, persist separate commit/push
receipts, attest the remote refs and verify the resulting PR's immutable
commit identities. Remote commit SHA attestation remains a distinct gate.

The current local check requires an existing local `main` ref at the
approved base SHA. Worktrees without that ref fail closed instead of
silently using a stale or guessed base. No automatic fetch is attempted.

## Verification

`tests/delivery-local-git-attestation.test.ts` covers clean SSH/HTTPS
remotes, dirty/staged/untracked worktrees, detached/changed branches,
stale commits, foreign or credential-bearing remotes, changed worktree
identity, stale operation keys, blocked plans, second-pass mutation and
Git command failures.

`tests/delivery-publication-service.test.ts` verifies that the injected
local check runs inside the publication lease and before remote GET,
journal reservation and POST, and that a local failure blocks every
remote action. Full CI must pass before merge.

This implementation is not a production-enabled delivery workflow.
