# AI Office roadmap

> Planning document, not a release promise. The source of truth for shipped functionality is tagged releases and their validation evidence. Security boundaries must never be inferred from a UI setting alone.

## Shipped

- **v0.3.0:** Two fixed Codex slots, persistent queues, read-only sessions, PHOSPHOR OS.
- **v0.4.0:** Explicitly approved isolated write worktrees, Git diff review, Keep/Reject, conservative cleanup.
- **v0.5.0:** Code Review Center, revision-bound feedback, Request Changes against the original Codex session, retained review history and safety audit. [Release](https://github.com/vlovers/ai-office/releases/tag/v0.5.0).

## v0.6.0 — Agent Studio (merged into main; release candidate, not tagged)

**Goal:** Replace the hard-coded “Codex 01 / Codex 02” identity model with user-managed, persistently configured agent profiles while retaining the existing security and task lifecycle guarantees. v0.6 targets **Codex SDK only**. Provider adapters are a future extension, not a reason to claim unsupported functionality now.

### P0 — foundation and safe migration

- [x] Audit the actual code paths, SQLite schema, queue, agent identity, leases, SSE, UI and session resume before proposing the migration.
- [x] Agent registry with stable IDs, display name, role, optional description, archived status, created/updated timestamps and deterministic ordering.
- [x] Upgrade existing installations without losing tasks, review threads, sessions, assigned owners, worktrees or pending work. Preserve the two existing agents as ordinary default profiles; migration must be idempotent and rollback-safe.
- [x] Separate **saved agent count** from **concurrent execution limit**. Initial concurrency must not exceed currently verified safe bounds; use a bounded configurable limit only after proving isolation and restart behavior.
- [x] Database and server-side validation for create/edit/archive/list and assignment; archive instead of deleting referenced agents.

### P0 — configuration and safety

- [x] Role/instructions and configurable model **only where verified supported** by the pinned Codex SDK and installed CLI. Unsupported settings should be visibly unavailable, not silently ignored.
- [x] Versioned immutable _effective configuration snapshot_ per execution/review iteration, including provider capability and policy version; an edit must not mutate a running or resumable session unexpectedly.
- [x] Server-enforced authority caps: read-only by default, explicit isolated-write authorization, registered workspaces, sandbox boundaries, approved verification. Agent instructions are not security controls.
- [x] Enforce effective permissions as intersection of platform policy, workspace/user approval and agent configuration. Never allow UI/API requests to expand host privileges.
- [x] Reject known/configured credentials in profiles and redact configured/known tokens in transcripts/errors; do not offer configuration export or claim universal secret detection.

### P1 — Agent Studio UI

- [x] Create/edit/archive/duplicate profiles and inspect their effective permissions and provider support.
- [x] Select a profile when creating/assigning a task, including worktree/review history; show the exact profile version bound to a session.
- [x] Preserve accessibility, responsive layouts, keyboard controls, reduced-motion preferences and the existing PHOSPHOR OS aesthetic.
- [x] Clear empty states, offline/connection errors, blocked permissions and upgrade migrations.

### Delivery plan (separate reviewable PRs)

1. Discovery/spec, compatibility matrix, threats and migration test fixtures.
2. SQLite migration and typed Agent Registry API, preserving legacy identifiers.
3. Snapshot semantics and server-side policy enforcement; resume/recovery tests.
4. Task/queue/SSE/worktree binding and bounded scheduling.
5. Agent Studio UI and migration/UX integration.
6. Comprehensive security, browser, native sandbox and release-validation documentation.

Implementation and exact validation: [workflow/migrations](docs/V0_6_AGENT_STUDIO.md),
[PR stack/security report](docs/V0_6_VALIDATION.md). Checkmarks describe the implementation merged into `main`, not an approved or tagged release. Known-pattern secret handling and macOS fixture
validation do not establish arbitrary-content secrecy or Linux runtime safety.

### v0.6 exit criteria

- Existing v0.5 fixtures and persisted installations migrate with no lost task/review/session state; upgrade and restart tested.
- Create, edit, archive and assign profiles persist; old sessions remain bound to original effective config.
- No privilege escalation via prompt or config; no unapproved host execution; worktree ownership and correction-loop invariants remain intact.
- Typecheck, unit/integration, HTTP/SSE, browser, native macOS sandbox and build/format CI pass. No claim of Linux sandbox compatibility without real evidence.
- New functionality is opt-in or backward-compatible; README, architecture, security, changelog, migration notes and release evidence reflect real behavior.

## v0.7.0 — workflow orchestration (merged into main; not tagged)

Integrated via [PR #24](https://github.com/vlovers/ai-office/pull/24): Coder → SDK Reviewer → sandboxed QA, pinned source/runtime provenance, manual stage/result gates, durable reports, fail-closed recovery, Review Center actions, and an initial isometric Office Experience baseline with live agent/queue/history data. Follow-up Office V2 fixes merged via [PR #27](https://github.com/vlovers/ai-office/pull/27). Office V4 and the combined operations interface were merged through [PR #36](https://github.com/vlovers/ai-office/pull/36), superseding draft PRs #31, #33, #34 and #35; see [state mapping and validation](docs/OFFICE_V4.md). The superseded draft PRs #22 and #23 were closed without separate merges. Validation CI #266 passed both the TypeScript/unit/integration/browser/build/format job and native Codex filesystem-policy, recovery/security and browser approval journey job. See [implementation and limitations](docs/V0_7_WORKFLOW_ENGINE.md). This is **merged implementation, not a tagged release or deployment**. Release review, broader repository support and Linux native success-path validation remain separate gates.

## Operations follow-up (unreleased)

- Read-only filtered task history CSV export with spreadsheet-formula neutralization, deterministic column order and no prompts, logs or local paths.
- Workflow Operations focus mode (selected workflow only), one-click reset of triage/search/state/sort filters, and browser-local CSV export of the filtered workflow triage view (ID, repository, state, derived triage, version, updated time). No reports, prompts, commands or filesystem paths are exported. These features change only UI projections, never workflow authorization or execution. Export is performed in the browser; it never triggers workflow actions or server writes.

## v0.8.0 — delivery integration (proposal)

Verification dashboard and explicitly authorized GitHub PR preparation/publishing, minimal GitHub permissions, revision-pinned checks, manual confirmation for push/PR actions. The [GitHub Delivery Center contract](docs/GITHUB_DELIVERY_CENTER.md) defines server-side revision checks, explicit commit/push/PR approvals, fail-closed recovery and acceptance tests. **This is a specification, not a shipped integration.**

### v0.8 publication foundation (unreleased)

The delivery publication boundary now combines the shared Git lease, refreshed
review snapshot, durable SQLite operation reservation, strict GitHub draft PR
receipt verification and read-only uncertain-result reconciliation. SQLite
integration tests cover duplicate requests, concurrent callers, timeouts,
forked PRs and restart recovery. This is **not** a connected GitHub publisher:
commit/push approvals, real GitHub authentication, immutable remote head SHA
verification, HTTP authorization and UI remain outstanding. A server-only,
GET-only GitHub REST adapter now provides bounded, fully paginated discovery
for reconciliation, but it is not connected to a production endpoint.
See [pipeline safety and activation gates](docs/DELIVERY_PUBLICATION_PIPELINE.md).

## Non-goals for v0.6

Autonomous agents managing each other, unlimited concurrent processes, external providers without verified adapters, shared/multi-user hosting, automatic merging or deployment, bypassing sandbox/host-verification controls, or fabricated model/tool capabilities.
