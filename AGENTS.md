# AI engineering contract — ai-office

Read README.md and existing engineering/product policies before changes. ROADMAP.md, docs/ARCHITECTURE.md, docs/SECURITY.md, docs/MVP_STABILIZATION_CHECKLIST.md are relevant source documents; confirm paths before treating references as authoritative.

## Product boundaries
Local-first agent execution, task queue, write authorization, registered workspace roots, worktree ownership, SSE lifecycle, Review Center and durable recovery. Never expose the local server publicly, elevate agent privileges from prompt/UI, auto-merge, or imply generic host safety.

## Agent workflow
1. Discover the current branch, code, PR/issue queue and existing tests; never assume a previously claimed implementation exists.
2. Plan a cohesive user-visible delivery with acceptance criteria, contracts, non-goals, risk and testing.
3. Implement in a dedicated branch/worktree. Parallel agents need isolated trees and clear file/API ownership. Preserve unrelated changes.
4. Execute applicable validation, record exact commands/results and never silently disable checks or replace real behavior with mocks.
5. Independent reviewer assesses original diff, acceptance criteria, correctness, regressions, safety, compatibility and test value; resolve blockers.
6. Document evidence, handoff SHA, outstanding limitations and next action. Never auto-merge or deploy/publish without approval.

## Relevant verification
- `npm run format:check`
- `npm run check`
- `npm run test:sandbox (supported sandbox)`
- `npm run test:browser`
- `npm run test:browser:workflow`
- `npm run test:real:workflow (only with intentionally authorized real Codex setup)`

Only use disposable databases and safe fixtures for tests that mutate state; never use production credentials. Commands are guidance, not claims of execution. Confirm scripts and environmental prerequisites.

## Project-specific acceptance
Workflows: read-only default, explicit writes, sandbox, token/session redaction, task cancellation/resume, queue idempotency, snapshot version binding, worktree isolation, browser flows and migration integrity.

## Release boundary
Verify current tagged release separately from features merged into main; real Codex smoke and native sandbox environment must be evidenced, not inferred from mocked tests.

See [Definition of Done](docs/engineering/DEFINITION_OF_DONE.md), [Independent review](docs/engineering/REVIEW_POLICY.md), [Release checklist](docs/engineering/RELEASE_CHECKLIST.md) and [PR template](.github/PULL_REQUEST_TEMPLATE.md).
