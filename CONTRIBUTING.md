# Contributing to AI Office

AI Office is an experimental, local-first coding-agent workspace. It is intended for one operator on a trusted machine; neither the UI nor the agent sandbox is a multi-user security boundary. See [SECURITY.md](SECURITY.md) and the [runtime threat model](docs/SECURITY.md) before changing permissions or execution paths.

## Before opening an issue or PR

1. Search existing issues and PRs. Use the bug-report form for **sanitized, reproducible non-security defects** and the engineering-task template for scoped proposals. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
2. Use Node.js 24.x and npm. Install dependencies with `npm ci`; avoid changing the lockfile unless dependencies are intentionally updated.
3. Branch from `main`, keep changes scoped, and explain the observed behavior, expected behavior, non-goals, compatibility and rollback considerations.
4. Use disposable repositories, synthetic SDK events and redacted fixtures. Never commit local SQLite databases, prompts, transcripts, tokens, private repository contents, real thread/session identifiers or credentials.
5. Record the **exact commit and CI run** in the PR. Separate implementation, automated validation, independent acceptance, merge and release; a green CI job alone does not approve a security-sensitive change.

## Local validation

Run `npm run check` and `npm run format:check` for ordinary changes. For UI or navigation changes, install Chromium with `npx playwright install chromium` and run `npm run test:browser`. For Agent Studio and office scene changes, run `npm run test:browser:studio` and `npm run test:browser:office` as applicable. For workflow or QA changes, run `npm run test:workflow:native` and `npm run test:browser:workflow` on a supported macOS host; for isolated write changes, run `npm run test:browser:write`.

Filesystem permission changes also require `npm run test:sandbox` on supported macOS. Browser tests use deterministic fixtures and **do not** establish the safety of a live model session. Native sandbox coverage and real Codex execution must be reported separately, including platforms not tested. Do not run real-model, paid or host-write tests as a default CI substitute.

## Permission and execution boundaries

Read-only agent execution is the default. **Opt-in isolated writes already exist**: they require configured authorized roots, a dedicated worktree, pinned session/workspace ownership and explicit operator confirmation. Do not silently broaden roots, reuse read-only sessions for writes, permit unsandboxed fallbacks, or add automatic merges, pushes or destructive cleanup.

Reviewer and QA stages have separate, explicit approval gates. QA runs only an operator-configured command in the native read-only sandbox; it must not be redirected to host verification. Host verification is a **separate, disabled-by-default opt-in** that executes trusted project code with the operator's OS permissions, outside the Codex sandbox. Never enable it to make a failing test pass. Changes to leases, recovery, Git metadata, command provenance, credential handling or sandbox policies require threat-model updates and independent review.

## Project conventions and review evidence

The codebase uses TypeScript, React, Fastify, SQLite, Vitest and Playwright. Task, workflow and agent progress must reflect persisted runtime events, not invented completion. Keep the UI keyboard-accessible and respect reduced motion. Document new environment variables, schema migrations, supported platforms and recovery limitations.

PR descriptions should include a reproduction or design rationale, tests actually run (with failures and skipped coverage), security impact, reviewer findings, migration/rollback guidance and remaining uncertainty. Release and publication are separately authorized operations, not consequences of CI success.

For the isolated-write setup, see [the v0.4 demo](docs/V0_4_DEMO.md); for current workflows and recovery, see [v0.7 workflow documentation](docs/V0_7_WORKFLOW_ENGINE.md) and [workspace recovery](docs/WORKSPACE_RECOVERY.md). Maintainers review contributions when available; no response time is guaranteed.
