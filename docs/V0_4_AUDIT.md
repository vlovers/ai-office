# v0.4 audit and implementation plan

Baseline: `0f7944e` on the GitHub default branch `main`, inspected before implementation. No AGENTS.md was present. The working checkout was clean. GitHub had no open non-PR issues; the two open dependency PRs concerned GitHub Actions versions.

## Existing behavior

- Node 24, TypeScript, Fastify, React/Vite, SQLite via node:sqlite. Backend binds loopback; browser uses same-origin JSON and SSE. The Phosphor interface supplies native controls, focus navigation, reduced-motion settings and text-only logs.
- Store schema v3 persisted repositories, tasks, sessions, private authentication bindings, events and a submitted FIFO queue. Previously active tasks recover as interrupted; unsubmitted tasks stay dormant.
- Two independent provider instances each run one task. A canonical Git-directory lease serializes access to a registered checkout. Resume requires the original repository, agent, authentication context and a CLI-owned transcript.
- Provider workers run the pinned `@openai/codex-sdk` **0.162.1**, verified in package.json, lockfile, installed declarations and implementation. The SDK exposes `startThread`, `resumeThread`, `runStreamed` and AbortSignal, named config overrides, workingDirectory, and legacy sandbox modes. We retain the existing named filesystem profile instead of combining it with legacy `sandboxMode` flags that override its restrictions. Official SDK reference: https://learn.chatgpt.com/docs/codex-sdk.
- Stop aborts the SDK turn, escalates to process-group termination, and retains the lease until the worker closes. Server disconnect also aborts workers. Unknown/stale leases fail closed after an unclean shutdown.
- Baseline file summaries used Git status, including pre-existing modifications. There was no worktree creation, actual patch review, verification, or review decision.
- Tests include store migrations, manager queue/session lifecycle, real SDK transport with a fake CLI, HTTP/SSE, auth isolation, browser checks and a credential-free native sandbox probe. CI runs TypeScript, tests, smoke, build, Prettier and deterministic Playwright. Paid-model tests are separate opt-in scripts.

## Smallest implementation

1. Add explicit execution mode while treating legacy tasks/sessions as read-only.
2. Require operator-configured canonical write roots and per-start user confirmation. Create a dedicated branch/worktree at HEAD; never copy a dirty primary checkout.
3. Persist workspace ownership, base commit and review decision in schema v4. Reuse the existing supervised workers, queue, session identity and leases; use a write permission only for the isolated directory and keep Git metadata denied.
4. Read live Git diffs against the saved base, including committed, staged, unstaged and untracked changes, independently of the agent lifetime.
5. Run operator-configured argv verification with time/output bounds and minimal environment. Explicitly disclose that verification executes trusted host code.
6. Keep changes or explicitly discard uncommitted worktree files. Never delete branches, merge or push. Refuse automatic rejection if HEAD advanced or ownership changed.

## Risks considered

Git worktrees share a common object store and refs; they are not containers. Deny Git metadata to the agent and serialize backend mutations using existing leases. Revalidation and fixed Git argv prevent UI-controlled deletion paths. Human editors and malicious same-user processes remain outside the coordination boundary. Sensitive-path filtering and existing redaction are defense in depth, not a complete secret scanner. A crash between Git creation and SQLite persistence can leave an orphan: preserve it for manual inspection, never guess ownership or delete it at startup.
