# Contributing to AI Office

Thanks for helping make local-first developer agents safer and more useful.

## Before opening a PR

1. Search existing issues and PRs; open an issue first for major features or permission-model changes.
2. Use Node.js 24.x and npm. Install with `npm ci`.
3. Make small, focused changes on a branch from `main`.
4. Run `npm run check` and `npm run format:check`. For UI changes run `npx playwright install chromium` and `npm run test:browser`; for permissions changes run `npm run test:sandbox` on supported local macOS.
5. Submit a PR explaining behavior changes, tests, limitations, and any security impact. Do not push generated session transcripts or local databases.

## Lint

`npm run lint` checks all of `src/`, `tests/` and `scripts/` (about 235 files). Errors fail CI: the original security rules, async hazards (`no-promise-executor-return`, `no-unsafe-finally`, `no-async-promise-executor`, …), React `rules-of-hooks`, and `local/no-floating-async-call`, which flags unawaited calls to async functions in the same file and `.then`/`.finally` chains without a rejection handler. `no-shadow` and `react-hooks/exhaustive-deps` are warnings; existing debt is capped by `--max-warnings` so new warnings fail CI. Lower the cap when you fix one. Unused locals and parameters are enforced by `tsc` (`noUnusedLocals`, `noUnusedParameters`). Type-aware rules (e.g. `no-floating-promises`) are unavailable because `typescript-eslint` does not support TypeScript 7.

## Security requirements

The current runtime is single-user, loopback-only, repository-scoped and read-only. Do not loosen permissions, add network access, change authentication handling, or implement write actions without a separate security review and explicit approval design. Never use real credentials or paid model calls in automated tests. Use deterministic SDK fixtures instead.

Please report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in a public issue. See [architecture](docs/ARCHITECTURE.md) and [trust boundaries](docs/SECURITY.md).

## Project conventions

TypeScript, React, Fastify and SQLite; tests use Vitest and Playwright. Keep task/agent state backed by actual runtime events, never invented progress. UI must remain keyboard-accessible and respect reduced motion. Document new environment variables, migrations and unsupported platforms.

This project welcomes bug fixes, reproducible tests, accessibility work and documentation improvements. Maintainers review contributions when available; no response time is guaranteed.

Isolated coding setup, disposable-worktree validation and the optional real write smoke test are documented in [the v0.4 demo](docs/V0_4_DEMO.md).
