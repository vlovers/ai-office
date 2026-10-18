# Codex implementation prompt — AI Office v0.6.0 Agent Studio

You are working in the existing **vlovers/ai-office** repository on top of current `main`. Build **v0.6.0 Agent Studio**, a robust replacement for the two hard-coded Codex 01/02 identities. Preserve all shipped v0.5 Code Review Center functionality and safety guarantees. This is an implementation project, not a proposal-only exercise.

## Operating rules

1. Inspect the repository, current tests, SQLite migrations, Codex SDK calls, task queue, SSE, worktrees, permission checks, review/retry lifecycle, documentation and existing CI **before editing**. Read `ROADMAP.md` and v0.5 audit/validation docs.
2. Confirm the exact capabilities of the currently pinned `@openai/codex-sdk` and installed CLI from authoritative local types or official docs before offering configurable model, instructions or tool controls. Never invent config fields or pretend that natural-language prompts enforce permissions.
3. Work in a feature branch; build in small, logically separated, reviewable PRs. Do not push to `main`, merge, tag or publish a release without explicit user approval. Preserve commits and provide links and validation evidence.
4. Do not read, print or copy local authentication data. Never introduce a new API-key requirement; honor existing local ChatGPT CLI authentication and explicit paid API-key mode. Avoid real inference/billing unless specifically approved.
5. The default profile must be read-only. Isolated writes remain server-authorized and require all existing user confirmations and worktree restrictions. No unapproved host verification. All agent config from UI/API is untrusted input.

## Phase 0 — ground truth / specification

Map existing identity assumptions (two slots), tables/foreign keys, task ownership, worker concurrency, queue order, leases, resumable sessions, stop/cancel, revision-bound feedback, Request Changes, Keep/Reject, Git worktree ownership and browser routing. Identify all places that would break if profiles were not limited to two. Document an actual schema/API/migration plan, a permission threat model, supported SDK configuration capabilities, and rollback/recovery cases. If a promised setting cannot be implemented safely, clearly mark it unsupported rather than simulating it.

## Target functionality

**A. Agent Registry.** Users can create, edit, duplicate, archive and list any number of persisted agent *profiles*. Stable opaque IDs, name, role, optional description, instruction text, profile revision, lifecycle metadata, and validated optional supported model/provider settings. Archive cannot orphan historic tasks. Migrate the two existing built-in agents to editable profiles with their historical tasks, reviews and active/queued sessions intact. Idempotent transactional migration and recovery tests are mandatory.

**B. Execution snapshots.** New task executions capture an immutable versioned effective agent configuration/policy. Editing a profile must not change the rules of a running/resumable session. Define explicit semantics for corrections to an existing Codex thread: reuse the pinned session/config or reject incompatible profile edits; never silently swap SDK sessions or permissions. Keep reproducible records with safe redaction.

**C. Secure permissions.** Effective operations are constrained by server policy ∩ workspace authorization ∩ agent preferences. Separate descriptive role/instructions from executable privileges. Do not offer per-agent filesystem/shell/tool allowlists unless the SDK and server can genuinely enforce them. Read-only, isolated writes and host verification retain existing constraints and confirmations. Validate REST inputs, reject unexpected fields, defend against IDOR/path escapes and stale updates; ensure secrets never enter logs/SSE or UI.

**D. Scheduling.** Remove assumptions of exactly two profiles without equating unlimited saved profiles with unlimited parallel executions. Keep existing verified concurrency bound initially. Preserve fairness, leases, cancellation, queue persistence, restart recovery, session ownership and task-scoped SSE; prove no double-run or stuck queue after migration.

**E. UI.** Build an accessible **Agent Studio** consistent with existing PHOSPHOR OS: list/cards, create/edit/duplicate/archive, detailed configuration panels, capability/permission descriptions, version indicators, user-friendly validation, and task assignment. Show what a configuration really does versus settings that are unsupported. Keep small screens, keyboard support, focus management, reduced motion and safe text rendering. Avoid introducing fake toggles.

## Suggested PR sequence

1. Discovery and architecture decision record; migration threat model and capability matrix.
2. Registry schema, API, idempotent migration and compatibility tests.
3. Versioned execution configuration + effective-policy enforcement, correction/recovery invariants.
4. Dynamic assignment and scheduler/queue/SSE/worktree integration.
5. Agent Studio UI, existing dashboard integration, browser/accessibility regression tests.
6. Security hardening, end-to-end validation, documentation and v0.6 release-readiness report.

Adjust boundaries if repository reality demands it, but communicate the reason. Each PR must be independently reviewable, have a green CI, and preserve working functionality.

## Mandatory tests / acceptance

- Upgrade a real shaped v0.5 fixture with two agents, active/queued/finished tasks, linked sessions, review comments and revisions; verify references survive restart.
- Persistence and validation for create/edit/archive/duplicate, duplicate names, malformed instructions, unexpected JSON fields, stale update conflicts, unauthorized workspace assignment.
- Profiles >2; concurrency remains bounded; fair queue, cancellations, worker crashes, app restart, interleaved SSE, pending Request Changes and blocked worktrees.
- Editing/archiving while task in-flight never changes effective permissions or identity. Reuse of original Codex session for correction rounds is preserved.
- Attempts to escalate via config/instructions cannot enable host commands, escape roots, access neighboring worktrees or bypass explicit approvals.
- Check security redaction, API error safety, migration failures/rollback and UI accessibility.
- Run available `npm run typecheck`, `npm test`, `npm run test:smoke`, `npm run test:browser`, `npm run test:browser:write`, `npm run test:sandbox`, `npm run build`, `npm run format:check`, `git diff --check`; document unsupported machine-specific checks rather than claiming they ran.

## Deliverables

Provide the implementation in GitHub PRs, schema/migration docs, updated README/ROADMAP/ARCHITECTURE/SECURITY/CHANGELOG, screenshot or synthetic fixture evidence of the UI, and an audit report listing exact tests executed, remaining security risks and known limitations.

Stop and report blockers if the SDK lacks a needed enforceable capability or migration endangers persisted state. Do not weaken safeguards to satisfy the UX. **Do not create a v0.6 release until separately approved.**
