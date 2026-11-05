# Multi-agent GitHub delivery protocol — AI Office

This is a coordination protocol, not an authorization grant. [AGENTS.md](../../AGENTS.md), [review policy](REVIEW_POLICY.md), [Definition of Done](DEFINITION_OF_DONE.md), and existing security controls take precedence. This document governs engineering delivery, **not** the application's runtime agent execution or approval engine.

## 1. Intake and one parent issue

Before work, read the default branch, open Issues, existing PRs, the relevant documentation and actual package scripts. Reuse an existing parent Issue and existing integration PR where appropriate. The parent Issue records: outcome, acceptance criteria, explicit non-goals, security impact, owners, dependency graph, verification plan and blocked decisions. A task without a parent or an accepted exception does not enter parallel execution. Cross-repository coordination is tracked in [#87](https://github.com/vlovers/ai-office/issues/87); it does not authorize editing other repositories.

Prefer **one substantial integration PR per logical outcome**. Do not create PRs per tiny change, CI rerun, or agent. If parallel agents need independent reviewable diffs, use temporary branches/worktrees and integrate into the agreed PR head after validation. Existing product PR stacks are not automatically governance tasks.

## 2. Agent ownership (2–5 agents when parallelism helps)

Before launching parallel work, the coordinator records the following matrix in the parent Issue or PR:

| Role                       | Responsibility                                                                    | Write permissions                       |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| Coordinator / integrator   | Owns parent Issue, dependency ordering, integration branch, final SHA and handoff | Integration branch only                 |
| Implementer A              | Owns a specified non-overlapping file/path set and acceptance subset              | Its own worktree/branch                 |
| Implementer B–D (optional) | Independent file/path set and test/analysis tasks                                 | Their own worktrees/branches            |
| Independent reviewer       | Inspects the actual diff, threat boundaries, tests and acceptance evidence        | Review comments only, not self-approval |

Two agents is not a minimum when the work cannot be safely partitioned; never fabricate parallelism. A person/agent can coordinate without being an independent reviewer of its own changes. Record ownership for shared contracts (API types, auth/tenant policy, SSE events, persistence schema, workflows and CI). A shared path has **one active writer**; dependent agents consume an agreed interface and wait for integration rather than racing edits. Ownership claims are advisory, not filesystem locks or GitHub permissions.

## 3. Isolated worktrees and dependency order

Start from a verified base commit and note its full SHA. Example (illustrative, do not run without checking current state):

```sh
git fetch origin
git worktree add ../ai-office-task-a -b task/<issue>-a origin/main
git worktree add ../ai-office-task-b -b task/<issue>-b origin/main
```

Do not share a writable checkout or run concurrent Git operations in the same worktree. Never force-push, reset or delete someone else's work. Use a dependency graph with explicit `blocked-by` references; integrate contract-owner changes before dependent code. Before cherry-pick/rebase/integration, re-fetch and inspect base/head SHAs, working tree, diff and conflicting file owners. Pause on unexpected modifications; resolve with the responsible owner rather than overwriting them.

## 4. Integration, security and review

The integrator collects tested commits into the existing coherent integration PR, checks the diff for unrelated code and updates the parent Issue. Preserve AI Office's loopback-only UI, Delivery API approval/Origin/CSRF, credential boundaries, grant/lease checks, immutable Git/ref attestations, audit/receipt invariants and crash recovery. This protocol cannot relax any security gate.

For each verification claim record command, environment, timestamp, **exact tested full commit SHA**, result and CI/job URL or retained artifact. Run the actual applicable scripts, including `npm run check`, `npm run format:check` and relevant browser/native sandbox suites; don't infer native macOS or live Delivery validation from mocks. Mark `not run`, `blocked`, `failed` or `N/A + reason` accurately. Revalidate after any material rebase or file change. CI green is not independent review.

Reviewer must independently inspect the current PR diff and acceptance criteria, classify blocking findings, and request fixes. The implementer cannot approve its own work. No autonomous merge, deploy, package publication, production configuration/secret changes, branch-protection edits or approval bypass.

## 5. Handoff, artifacts and recovery

Every handoff includes: parent Issue, PR URL, owner and reserved paths, base/head/tested full SHAs, commits integrated/pending, dependency status, exact checks and failures, security notes, docs updated, artifact links/retention and the next safe action. Never attach secrets, user data, unredacted logs or credential-bearing fixtures.

On interruption: fetch current GitHub state first; compare recorded head to actual head, list open PRs and working-tree changes, inspect last successful checks and pending review comments. If a SHA differs, do **not** resume from stale assumptions; reconcile ownership and rerun affected validation. Avoid duplicate Issues/PRs and never treat a queued CI job as a pass. If safe continuation is impossible, record the blocker and stop the affected change only.

## 6. Completion

Completion requires acceptance criteria with reproducible evidence, security assessment, documentation, independent review and all required checks at the final head SHA (or explicit approved exceptions). An unmerged PR is **proposed**, not released; a merged change is not proof of deployment or acceptance. Record outstanding risks and rollback/recovery actions in the PR.
