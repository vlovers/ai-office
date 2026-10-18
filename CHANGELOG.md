# Changelog

## [0.5.0] — Released 2026-10-18

- Code Review Center with directory-grouped file navigation, bounded unified diff lines and accessible feedback controls.
- SQLite schema 6 preserves revision-bound comments, submitted feedback, iteration outcomes and attributed verification.
- Explicit Request Changes confirmation resumes the original Codex session through the existing queue, worker and leases; stale and duplicate submissions are controlled.
- Historical patches survive restart and Keep/Reject; no filesystem snapshots or automatic integration.
- Audit fixes for queued correction cancellation, pinned-session recovery, and unsaved feedback protection after failed saves.
- Verified 87 unit/integration tests, 2 HTTP/SSE tests and browser/native sandbox checks in disposable fixtures; see [validation](docs/V0_5_VALIDATION.md) and [audit](docs/V0_5_SECURITY_AUDIT.md).

**Limits:** bounded historical patches, reliance on native Codex transcripts, and opt-in host verification. No autonomous merge/deployment or Linux native sandbox validation.

This project follows semantic versioning for release labels. Until a stable 1.0 release, APIs and storage formats may change.

## [Unreleased] — v0.6 Agent Studio implementation

- Persisted editable/duplicate/archive/restore Codex profiles with stable IDs and append-only revisions.
- Transactional schema 7/8 migration retaining v0.5 ownership, queues, sessions, workspaces and review history.
- Immutable submission/effective/session configurations; corrections retain original guidance, model and authority.
- Dynamic profile assignment and fair FIFO scheduling within the two-worker bound; cleanup uncertainty retains capacity.
- Accessible PHOSPHOR Studio, pinned/current version details, responsive dialogs and deterministic browser/restart coverage.
- Explicit model IDs required for API-key execution when a default cannot be resolved; unknown legacy API models fail closed.
- [Workflow/migration](docs/V0_6_AGENT_STUDIO.md), [validation/audit](docs/V0_6_VALIDATION.md), and synthetic visual evidence. No release or real inference performed.

## [0.4.0] - Released

### Added

- Explicitly confirmed write-enabled Codex tasks in isolated Git worktrees and dedicated branches.
- Persistent Git diff review, bounded opt-in host verification, Keep and confirmed Reject.
- Workspace ownership fingerprints, repository leases and conservative restart recovery.
- Native filesystem policy and deterministic browser/safety tests; opt-in two-turn real Codex E2E with preserved evidence.

### Security

- Fail-closed canonical path, worktree identity and HEAD checks; confirmed review revisions.
- Restricted Git helpers, sensitive-path diff filtering, and branch-preserving cleanup.
- Host verification disabled by default; explicit permission required for unsandboxed commands.

### Limitations

- Experimental single-user local application, macOS-verified. Linux native sandbox remains unverified; the approved two-turn real Codex write E2E passed on macOS.
- No automatic integration, branch deletion or recovery of ambiguous resources. See [release notes](docs/releases/v0.4.0.md).

## [0.3.0] - 2026-10-16

### Added

- Two independently controlled read-only Codex agents with persistent FIFO submissions.
- Cross-instance worktree leases, agent-specific cancellation and recovery.
- Shared PHOSPHOR OS room with two interactive workstations, keyboard controls and reduced-motion support.
- Expanded test coverage for queue safety, restart recovery and UI behaviors.

### Limitations

- No write mode, automated Git mutations, autonomous planning or multi-user access.
- Native sandbox verified on macOS; Linux support remains unverified.
- Provider allowance is consumed separately by concurrently running agents.
