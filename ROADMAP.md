# AI Office roadmap

> Updated 2026-10-23 against `main` `b3f7ee9`. Planning is not a release promise. Read the [repository audit](docs/REPOSITORY_AUDIT_2026_10_23.md), [MVP acceptance checklist](docs/MVP_STABILIZATION_CHECKLIST.md) and [security model](docs/SECURITY.md). GitHub PR status and passing checks must be rechecked before merge.

## Product definition

AI Office is a **local-first, single-user Codex workspace** for assigning tasks to saved agents, following sessions and queues, approving isolated changes, reviewing diffs and running gated Reviewer/QA workflows. The near-term MVP is an end-to-end **human-supervised coding workflow**, not autonomous software delivery or multi-user hosting.

## Implemented in tagged releases

| Release | Scope                                                                               | Evidence                                                  |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| v0.3.0  | Two Codex slots, persistent task queue, read-only sessions, interactive office      | [Milestone](docs/V0_3_MILESTONE_A.md)                     |
| v0.4.0  | Authorized isolated writes, worktrees, revision-bound review, Keep/Reject, recovery | [Release verification](docs/V0_4_RELEASE_VERIFICATION.md) |
| v0.5.0  | Review Center, per-line feedback, Request Changes and review history                | [Validation](docs/V0_5_VALIDATION.md)                     |

The latest documented published release is **v0.5.0**. Never infer a published release from the `package.json` version.

## Implemented in main but not separately released

- **v0.6 Agent Studio:** saved create/edit/duplicate/archive/restore profiles, immutable execution configuration, bounded dynamic scheduling and legacy migration. [Guide](docs/V0_6_AGENT_STUDIO.md) · [Validation](docs/V0_6_VALIDATION.md).

- **v0.7 Workflow Engine:** operator-gated Coder → SDK Reviewer → optional read-only QA, pinned evidence, reports, recovery and Review Center integration. [Workflow](docs/V0_7_WORKFLOW_ENGINE.md) · [Validation](docs/V0_7_VALIDATION.md).

- **Office Experience V2:** interactive two-workstation SVG office with live agent selection, overflow roster and queue/history data. PR #27 was merged into `main`; it is not an unmerged release gate.

- **Workflow Operations:** PR #25 merged. Documentation synchronization PR #28 merged.

These statements describe merged source functionality, **not** a validated release of current main or a production deployment.

## In progress

### Office Experience V3 — Draft PR #31

[PR #31](https://github.com/vlovers/ai-office/pull/31) changes the visual palette and office environment, adds agent presence/filters, queue preview and collapsible operational details. Still a two-desk SVG visualization, not a game-like multi-room simulation.

**Gate:** resolve the observed formatting failure, run complete CI and browser suites on final SHA, review real desktop/mobile screenshots, reduced motion, keyboard interaction, text scaling and state fidelity. Do not merge solely because unit tests pass.

## Next implementation milestones

### M0 — Stabilize current main and establish release truth (P0)

- [ ] Resolve/validate Office V3 or explicitly defer it after visual review.

- [ ] Execute the [MVP checklist](docs/MVP_STABILIZATION_CHECKLIST.md) on a pinned main candidate, including real Codex and native macOS checks.

- [ ] Audit first-run workspace registration, profile selection, task launch, blocked states, review and recovery.

- [ ] Synchronize docs, screenshots, package version, release notes and actual tags; obtain explicit release approval.

**Done when:** a non-developer can complete a safe local task/review journey, all mandatory checks pass on one commit and known limitations are recorded.

### M1 — Office Experience V4 + workflow UX (P0)

- [ ] Define a cohesive visual system and scene composition before coding assets.

- [ ] Deliver high-quality responsive office, agent identities, truthful status cues, accessible selection and reduced-motion behavior.

- [ ] Surface task/session/review/approval context without clutter; provide useful empty/error/disconnected states.

- [ ] Avoid fictional work/progress, unsupported status mappings and CSS override accumulation.

- [ ] Validate screenshots and real UI behavior across desktop/mobile and varied agent/queue states.

**Done when:** actual browser screenshots and operator journeys are reviewed; functionality remains grounded in server state and approval gates.

### M2 — GitHub delivery (P1; previously proposed v0.8)

- [ ] Review existing Git/worktree ownership model and provider scopes before designing endpoints.

- [ ] Prepare an explicit, revision-pinned commit/branch/PR proposal from reviewed changes.

- [ ] Require separate user confirmation for remote push and PR creation; minimize GitHub permissions.

- [ ] Read PR/CI/review statuses and show failures/retry guidance.

- [ ] Never auto-merge, force-push or deploy.

**Done when:** a user can publish a reviewed change as a PR through a controlled flow with audit evidence.

### M3 — Scheduling, recovery and observability (P1)

- [ ] Persist schedules and execution intents with clear time zone, missed-run and duplicate-dispatch semantics.

- [ ] Enforce queue/worktree capacity and existing approval policy for each scheduled execution.

- [ ] Expose actionable run timelines, failure categories, logs and privacy-conscious diagnostics.

- [ ] Implement conservative retries only for proven-safe operations; no silent model retries or permission expansion.

**Done when:** scheduled jobs survive restart and fail safely under contention, denial and partial cleanup.

### M4 — Dependency-aware multi-agent workflows (P2)

- [ ] Introduce explicit task dependencies, bounded handoffs and human checkpoints.

- [ ] Prove independent worktree ownership, conflict detection and stale-result handling.

- [ ] Keep agent instructions separate from actual authorization.

- [ ] Extend concurrency only after native isolation and restart validation.

### M5 — Additional providers and deployment options (P2+)

- [ ] Verify each proposed SDK and its tool/sandbox/approval limitations before claiming support.

- [ ] Define provider capability contracts and fail-closed unsupported features.

- [ ] Consider multi-user authentication, tenant isolation and hosted deployment only as a separate security architecture project.

## Explicit non-goals for the local MVP

Autonomous merge/deploy, unlimited concurrent agents, public network exposure, multi-tenant SaaS, unverified SDK integrations, unattended host commands, secret-vault guarantees and silent permission escalation.

## Evidence discipline

- CI passing is **not** a real-model run, visual review or security proof.

- Ubuntu CI does **not** validate the native Linux Codex sandbox success path.

- Host verification runs with OS-user privileges when explicitly enabled; it is not equivalent to sandboxed QA.

- Keep/Reject is **not** GitHub delivery.

- Each milestone must record exact commit, environment, tests, screenshots, manual approvals and unresolved risks.
