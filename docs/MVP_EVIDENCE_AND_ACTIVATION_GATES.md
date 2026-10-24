# AI Office MVP evidence and activation gates

Status: Review checklist, not release approval. Updated 2026-10-24.

The local-first coding workspace and the unreleased Delivery service have separate deployment and acceptance requirements. Passing CI does not prove arbitrary workspaces or credentials are safe.

## Product acceptance

**Codex execution.** Verify task submission, two-worker FIFO scheduling, SSE, cancellation, restart and resume on a supported real macOS runtime.

**Agent Studio.** Verify saved profiles, immutable execution snapshots, migrations from populated v0.5 data, and edits during active sessions.

**Isolated editing.** Verify approved worktree-only writes, revision-bound Keep/Reject, dirty-worktree denial, host escape prevention and recovery.

**Coder, Reviewer and QA.** Verify actual stage transitions, approvals, reports, cancellation and restart using real Codex where expressly authorized.

**Office V4.** Verify real task and queue projections, keyboard interaction, reduced motion, mobile layout, disconnected state and truthful errors.

**Delivery authorization.** Verify target TLS ingress, operator enrollment, live grants, Origin/CSRF checks, least-privilege credentials and private audit records.

**GitHub Draft PR publication.** Keep remote writes off until issues #58, #68 and #70 are complete, independently reviewed and tested with disposable real Git repositories.

## Local MVP release gate

Freeze the exact source SHA and record operating system, Node, Git, Codex CLI and SDK versions.

Run `npm ci`, `npm run check`, `npm run format:check`, `npm run test:sandbox` and `npm run test:browser`. Keep both successful and failed evidence.

Perform a real Codex dashboard test only with explicit approval because it consumes provider allowance. Exercise task execution, cancellation, restart and review. Never commit private runtime artifacts.

Test migration, backup, restore and rollback with disposable databases containing task, session, profile and review history.

Conduct an independent review of permissions, secrets, leases, file ownership, sandbox restrictions and error handling. Document platform-specific limitations.

Require human release approval and verify the exact CI and native evidence before tagging. A merged PR is not itself a release.

## Delivery activation dependency chain

**Issue #68.** Approval consumption and matching journal reservation must commit atomically on the same SQLite connection. Prove crash and multi-process behavior.

**Issue #70.** Recheck verified operator session, live grants, exact repository ownership, immutable review and head/base SHAs inside the common Git lease. Require full open/closed PR discovery. Allow at most one Draft-only POST per durable intent; uncertain outcomes must reconcile through GET-only calls.

**Issue #58.** Require independently confirmed commit/push receipts, explicit stage approvals and isolated startup recovery. No blind retry after uncertainty.

**Deployment acceptance.** Verify TLS, cookies, CSRF, operator enrollment, least-privilege credentials, quotas, logs, credential rotation, backups and rollback in the target environment.

**Independent review.** Attempt revoked grants, stale reviews, moved references, foreign worktrees, malformed paginated responses, duplicate requests, timeouts, crashes and concurrently running recovery.

Automatic merge, force push, reset, deletion, deployment and unattended writes remain out of scope.

## Failure outcomes

Stale reviews, foreign repositories, changed refs or revoked grants must block writes before any external request.

Concurrent duplicates must reserve once. Crashes must retain journal evidence without reissuing an uncertain remote write.

Incomplete remote inventory, wrong PR destination, fork mismatches, unverifiable SHAs, GitHub errors and expired credentials must fail closed.

Concurrent restart recovery must use the same repository lease namespace. Denied confirmation must cause zero writes. Secret exposure is a release blocker.

## Evidence record

Record date, source SHA, runtime versions, commands, environment, outcome, private artifact location, reviewer and limitations for each scenario. Exclude tokens, home paths, private transcripts and unredacted traces.

Missing evidence means unverified, not passed. For details consult `README.md`, `ROADMAP.md`, `docs/MVP_STABILIZATION_CHECKLIST.md` and `docs/DELIVERY_PRODUCTION_CHECKLIST.md`.
