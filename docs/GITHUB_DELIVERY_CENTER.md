# GitHub Delivery Center — v0.8 implementation contract

Status: design and acceptance criteria only. **No GitHub publishing API or UI is implemented by this document.**

The unreleased [Delivery authorization foundation](DELIVERY_PRODUCTION_SECURITY.md)
now implements a separate authenticated API for review, stage approvals, durable
intent reservation and GET-only remote attestation. It has no publishing executor
or authenticated dashboard UI. See the [threat model](DELIVERY_THREAT_MODEL.md)
and explicit [production blockers](DELIVERY_PRODUCTION_CHECKLIST.md).

## Operator journey

1. Choose a completed, explicitly **Kept** isolated-write task. Show the registered repository, source base SHA, task workspace ownership and a bounded changed-file summary.
2. Revalidate repository/worktree ownership and current Git revision **server-side**, under the same lease rules used for review. Reject missing ownership, dirty or advanced unexpected HEAD, ambiguous Git remotes, stale revisions, nested repositories, untracked sensitive content and unsupported repository states.
3. Prepare a **read-only delivery preview**: intended base branch, unique task branch, commit summary, changed paths, file count, diff size, and a digest of the exact approved revision. No shell interpolation and no implicit network operations.
4. Require a separate, explicit confirmation for each irreversible/network action: (a) creating a commit in the owned worktree, (b) pushing a branch, and (c) opening a draft pull request. A preview or refresh must never authorize any of these.
5. After each step, persist intent and result separately. On timeout, restart, lost connectivity or uncertain remote outcome, **fail closed** and ask the operator to reconcile rather than retry automatically.
6. Show the GitHub PR URL, its exact head SHA, and read-only CI/check status. A changed head SHA invalidates prior approvals. No automatic merge, approval, deployment or branch deletion.

## Security and architecture constraints

- The local API stays bound to loopback and enforces Origin/Host/CSRF and strict request validation.
- Do not store GitHub tokens in SQLite, browser storage, task transcripts, export files or application logs. Prefer a verified, scoped GitHub authentication path; explicitly document required permissions and reject unsupported authentication.
- Treat repository content, remote URLs, branch names, commit messages, PR titles and descriptions as untrusted input. Use argument arrays with the existing hardened Git runner, never shell string concatenation.
- Only operate on registered Git repositories and task-owned worktrees. No arbitrary path, remote or organization selection from HTTP payloads.
- Pin base/head SHA, Git common directory, worktree identity and review generation in a delivery approval. Any drift requires a fresh preview and new approval.
- Keep the worktree and existing review records on failed publication; never reset, force-push, auto-rebase, auto-merge or delete user branches.
- Restrict remote operations to the verified target GitHub repository and default branch. A fork or detached/ambiguous remote requires explicit unsupported-state handling.
- Redact sensitive paths, credentials and remote URL userinfo from all browser-facing diagnostics.
- Avoid presenting a successful GitHub action until its remote result has been verified.

## Acceptance tests

- Read-only preview does not modify Git state or contact GitHub.
- Stale revision, modified HEAD, missing ownership and concurrent task mutation block confirmation.
- Failed/denied push leaves the task workspace intact and does not create a PR.
- Unknown remote outcome after interruption does not auto-repeat a push or PR creation.
- Existing PR is discovered/reconciled before an explicit operator retry; duplicate PRs are not silently created.
- GitHub check status is tied to the exact published head SHA and shows unknown/pending/failure without optimistic success.
- Tests cover hostile filenames, CSV/HTML/script-like PR text, malformed remotes, unexpected Git output, credential redaction and large diffs.
- Native macOS sandbox and browser approval journeys continue passing; Linux is not claimed verified without a native run.

## Delivery increments

1. Server-side immutable read-only preview and revision token, with tests for ownership, limits and drift.
2. Explicit commit/push confirmation with durable intent, verified auth and recovery handling.
3. Explicit draft PR creation, duplicate reconciliation, pinned CI status and accessible UI.

**Out of scope:** autonomous pushes, automatic merging, unattended releases, multi-user permissions and provider-neutral hosting.

## Implemented read-only preview (unreleased)

The delivery branch adds Code Review Center local readiness gates, a copyable PR
metadata draft, credential-free GitHub remote syntax validation and
`POST /api/tasks/:id/delivery/preflight`. This server endpoint uses a fresh
workspace review and reports `blocked` or `manual-review`; neither authorizes
commit, push, PR creation or merge. Repository ownership, remote permission and
exact Git state still require the full server-side validation contract above.
