# AI Office — MVP evidence and activation gates

Status: **review checklist; not release approval**. Updated 2026-10-24.

This document separates the existing **local-first, single-user coding workspace** from the **unreleased Delivery service**. A green CI workflow is not proof that arbitrary customer repositories, browsers or credentials are safe.

## Product slices and evidence

| Slice | Integrated baseline | Remaining acceptance evidence |
| --- | --- | --- |
| Local Codex task | Two workers, persistent FIFO queues and SSE | Fresh-install manual task, cancel, restart and resumed session on supported macOS |
| Agent Studio | Persisted profiles, immutable execution snapshots | Migration of populated v0.5 data; archive/edit while sessions remain active |
| Isolated editing | Approved worktree writes and revision-bound Keep/Reject | Dirty worktree, changed review revision, denied host escape and recovery |
| Coder → Reviewer → QA | Stage-gated workflow and sandbox verification | Real-model end-to-end run; explicit operator checkpoint before each consequential stage |
| Office V4 | Task/queue/profile projections | Mobile/keyboard/reduced motion and disconnected state against actual backend |
| Delivery authorization | Dedicated HTTPS-oriented sessions, Origin/CSRF and live grants | Target TLS/browser deployment, operator enrollment, real grants and private audit |
| GitHub publication | Server-only journal, leases, reconciliation and Draft PR primitives | #58, #68 and #70, independent audit and disposable-repo native crash testing |

See `README.md`, `ROADMAP.md`, `docs/MVP_STABILIZATION_CHECKLIST.md` and `docs/DELIVERY_PRODUCTION_CHECKLIST.md` for detailed contracts. The local application and Delivery service are not interchangeable deployment surfaces.

## P0 — release process

1. Freeze the intended release commit and record Node, Git, OS, Codex CLI and SDK versions. Record provenance, test commands and artifacts. Never label a merge as a release.
2. Run `npm ci`, `npm run check`, `npm run format:check`, `npm run test:sandbox` and `npm run test:browser` on the exact commit. Preserve failed as well as passing output.
3. Perform the explicit real-Codex dashboard scenario only with the operator's informed approval (it consumes allowance). Test clean task, cancellation, restart/resume and review. Keep local private data out of commits.
4. Exercise migration from an actual disposable pre-upgrade database, plus backup/restore and restart. Confirm existing task/session/review associations and immutable configuration snapshots.
5. Conduct a security review of worktree scope, noninteractive approval limits, secrets, CSRF, session expiry/revocation, concurrent leases and all side-effect routes. Document target-platform limitations.
6. Require a human go/no-go signoff with known blockers and rollback steps before tagging a release. Keep prerelease Delivery features distinctly described.

## P0 — Delivery activation dependency chain

**Remote writes remain disabled** throughout these steps until a separately approved activation review.

1. **#68 publication atomicity:** consuming an exact approval and reserving the journal entry must be one SQLite transaction. Prove crash and concurrency cases with real databases.
2. **#70 trusted server-only Draft executor:** re-attest operator/session/grants, worktree/repository ownership, exact review and head/base SHAs under the common Git lease. Complete open/closed PR inventory and use no more than one POST per durable intent. An ambiguous result is GET-only reconciliation, never automatic retry.
3. **#58 commit/push and restart safety:** independently confirmed exact commit and push receipts, stage approvals, per-workspace recovery, and no global recovery race; verify actual least-privilege credentials.
4. **Deployment controls:** target TLS and browser Origin/cookie/CSRF behavior, enrollment, grants, credential rotation, audit/quotas, backup/restore and rollback on a disposable remote.
5. **Independent security review:** adversarial races and failure injection; require explicit operator confirmation and separate activation decision.

None of these gates permits automatic merge, force push, reset, deletion, deployment or unattended repository writes.

## Mandatory failure matrix for any proposed Delivery activation

| Failure | Required outcome |
| --- | --- |
| Stale review, moved branch/head/base or foreign worktree | Fail closed before write; do not rebind approval |
| Revoked/expired session or live grant | Fail closed within transactional decision |
| Duplicate request across processes | One durable reservation; never duplicate POST |
| Crash before/after SQLite commit | Deterministic recovery; no lost authorization ambiguity |
| GitHub timeout, 403/429/5xx or malformed/paginated inventory | Keep unresolved/uncertain; GET-only reconciliation; no blind retry |
| Different repo/fork, duplicate PR or unverifiable SHA | Reject receipt and keep publication blocked |
| Crash during startup recovery with concurrent publisher | Shared lease prevents cross-process corruption |
| Operator denied confirmation | Zero remote writes; preserve safe review state |
| Secret/configuration leakage | Fail audit; scrub logs and artifacts, rotate affected credentials |

## Acceptance log template

For each scenario record: date, source SHA, system/runtime versions, environment type, command/manual steps, result, trace or private artifact location, reviewer and known limitations. Never commit tokens, home paths, private local transcripts or raw unredacted traces.

**Decision rule:** absent evidence means *unverified*, not *passed*. A green simulated test does not replace real-machine and real-browser acceptance. Existing tracked issues remain the source of truth for delivery work; avoid creating duplicate implementation tickets.
