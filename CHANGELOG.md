# Changelog

This project follows semantic versioning for release labels. Until a stable 1.0 release, APIs and storage formats may change.

## [Unreleased]

### Documentation
- Prepare open-source contribution, security and maintenance guidance.

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
