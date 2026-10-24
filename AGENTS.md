# AI engineering contract — AI Office

Read the README and existing engineering policies before changes.
Consult ROADMAP.md, docs/ARCHITECTURE.md, docs/SECURITY.md and
docs/MVP_STABILIZATION_CHECKLIST.md when relevant.

## Product boundaries

Local-first agent execution, task queues, write authorization, registered
workspace roots, worktree ownership, SSE lifecycle, Review Center and durable
recovery. Never expose the server publicly, elevate privileges through prompts
or UI, auto-merge, or imply generic host safety.

## Agent workflow

1. Inspect the current branch, code, PRs, issues and tests.
2. Plan a cohesive outcome, acceptance criteria, constraints and risks.
3. Implement in an isolated branch or worktree, preserving unrelated changes.
4. Execute checks and report exact commands and outcomes.
5. Obtain independent review of the diff and acceptance criteria.
6. Resolve blocking findings, document evidence and hand off the commit SHA.

Never disable tests to conceal failures or claim unexecuted checks passed.
Never deploy, publish or merge without required authorization.

## Relevant verification

- `npm run format:check`
- `npm run check`
- `npm run test:sandbox` (supported macOS sandbox only)
- `npm run test:browser`
- `npm run test:browser:workflow`
- `npm run test:real:workflow` (explicitly authorized real Codex setup only)

Use safe fixtures and never run destructive tests against production data.

## Project-specific acceptance

Verify read-only defaults, explicit write authorization, sandbox boundaries,
transcript redaction, task cancellation and resume, queue idempotency,
configuration snapshot binding, worktree isolation, browser journeys and
migration integrity.

## Release boundary

Distinguish current tagged releases from functionality merged into main.
Real Codex and native sandbox tests need environment-specific evidence;
mock-based checks alone are insufficient.

See [Definition of Done](docs/engineering/DEFINITION_OF_DONE.md),
[Independent review](docs/engineering/REVIEW_POLICY.md),
[Release checklist](docs/engineering/RELEASE_CHECKLIST.md) and
[PR template](.github/PULL_REQUEST_TEMPLATE.md).
