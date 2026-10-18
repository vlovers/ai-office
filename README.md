# AI Office

**Local-first coding workspace with reusable Codex agent profiles and two workers.** Delegate isolated coding tasks or read-only reviews, follow live progress, inspect Git diffs, run configured verification, and explicitly keep or reject changes.

![CI](https://github.com/vlovers/ai-office/actions/workflows/validation.yml/badge.svg) · [MIT License](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

> **v0.5.0 latest published release · v0.6.0 Agent Studio release candidate · Node.js 24.x** — Read-only by default. Isolated writes require server-configured authorization/workspace roots and explicit confirmation. The authorized root must contain the source checkout and its common Git metadata. No automatic merging or background deployments. Single-user local tool.

The v0.6.0 Agent Studio implementation is integrated into main, with [validation evidence](docs/V0_6_VALIDATION.md) and [usage/limitations](docs/V0_6_AGENT_STUDIO.md); no v0.6.0 tag or release exists yet. The v0.5.0 Code Review Center has passed the [PR validation](docs/V0_5_VALIDATION.md) and [focused security audit](docs/V0_5_SECURITY_AUDIT.md). It was [released as v0.5.0](https://github.com/vlovers/ai-office/releases/tag/v0.5.0); CI and local-fixture validation do not establish arbitrary host/runtime safety. The v0.4.0 baseline passed macOS real Codex write validation and automated checks. See [release notes](docs/releases/v0.4.0.md) and [verification evidence](docs/V0_4_RELEASE_VERIFICATION.md) for completed checks and remaining limitations.

**Unreleased v0.6 implementation:** [Agent Studio workflow and migration](docs/V0_6_AGENT_STUDIO.md) · [audit/validation and PR stack](docs/V0_6_VALIDATION.md) · [roadmap](ROADMAP.md). Create/edit/duplicate/archive persisted profiles; submitted tasks and corrections keep their original configuration. Saved profiles share two workers. This branch has not been released.

## Quick start

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4310**. Sign in with your existing Codex CLI via `codex login` if needed; the app prefers local ChatGPT login without API-key fallback. Register a trusted Git worktree, create a review task, assign an active agent profile, then explicitly click Start. Use Agent Studio to create or edit profiles. A task consumes provider allowance only when submitted for execution. New profiles prefer read-only; writes additionally require opting into the profile preference. Local model defaults are resolved from CLI metadata; explicit API-key execution requires a model ID.

**Code Review Center:** Navigate directory-grouped changed files, read bounded unified diffs, save general/file/line feedback, explicitly confirm Request Changes against the original Codex session, inspect preserved iterations, then Keep or Reject. See the [complete workflow and migration notes](docs/V0_5_REVIEW_CENTER.md), [threat model](docs/V0_5_SECURITY.md) and [validation evidence](docs/V0_5_VALIDATION.md). No automatic commits, integration or replacement threads.

**Why use it?** Persistent FIFO queues, isolated coding worktrees, Git diff review, explicit keep/reject, stop/resume, task-specific SSE, and an accessible pixel-art office. Start with [write-session setup and demo](docs/V0_4_DEMO.md) and [session lifecycle](docs/SESSION_LIFECYCLE.md). See [architecture](docs/ARCHITECTURE.md), [permission model](docs/SECURITY.md) and [v0.3 milestone](docs/V0_3_MILESTONE_A.md).

**Review UI:** [Production Code Review Center screenshot](docs/design/screenshots/v05-feedback.png), captured with synthetic SDK fixtures and a disposable repository. See [reproduction and validation](docs/V0_5_VALIDATION.md). Never commit private runtime captures or session data.

---

AI Office supports read-only reviews and write-enabled tasks in dedicated Git worktrees/branches. Review persists independently of the agent session. Keep preserves isolated changes; revision-confirmed rejection discards uncommitted task files while retaining the branch. Ignored files, nested repositories, advanced HEAD or ambiguous ownership require manual preservation and cleanup. Integrate kept changes manually.

**AI Office prefers your existing ChatGPT Codex CLI login. No `CODEX_API_KEY` is needed for local-login tasks.** API-key mode remains an explicit, separately billed option. Local authentication never falls back to API billing.

Read-only execution retains its original restrictive profile. Isolated coding grants writes only inside its dedicated worktree; primary checkout and Git metadata remain denied. The SDK has no interactive approval callback: actions requiring escalation stay blocked. Host verification is disabled by default. Enabling it requires AI_OFFICE_ALLOW_HOST_VERIFICATION=1 and separate confirmation of full host permissions; inspect AI-edited scripts before running them. See the [security model](docs/SECURITY.md), [security audit](docs/V0_4_SECURITY_AUDIT.md), and [workspace recovery](docs/WORKSPACE_RECOVERY.md).

## Requirements

- Node.js **24.x**, npm, and Git at `/usr/bin/git`.
- For local login: an existing **Codex CLI 0.162.1** on PATH, signed in with ChatGPT. This is the runtime verified with the pinned SDK/permission profile. AI Office never installs, replaces, or downgrades your CLI; unsupported versions report Connection error.
- macOS or Linux with functioning Codex OS sandbox support. macOS is verified; Linux remains unverified. Windows is unsupported because process cleanup uses POSIX process groups.

AI Office queries only non-sensitive CLI metadata. The CLI owns its login and any normal refresh internally. Application code never opens/copies authentication files or exports tokens. The browser receives no account identifiers, home paths, CLI paths, keys, or token payloads. Task context is sent to the selected AI provider; local-first does not mean offline inference.

## Start locally with ChatGPT login

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4310**. Select **Local ChatGPT login (preferred)**, which is also the default. A working login shows **Available**. You can create tasks without authentication, but Start requires an available connection.

If the UI shows **Authentication required**, sign in through your own terminal and then click **Refresh connection**:

```sh
codex login
```

An existing working ChatGPT login needs no new sign-in. AI Office does not log you in/out, read the login cache, or open an authentication flow in the dashboard. **Connection error** means the metadata/provider check failed or the installed CLI version is unsupported. No credentials or raw authentication diagnostics are displayed.

Development uses two terminals:

```sh
npm run dev
```

```sh
npm run dev:web
```

Open **http://127.0.0.1:5173**. The API is on 4310 and Vite proxies `/api` there. Both bind only to `127.0.0.1`.

Runtime data is private, Git-ignored `.ai-office/`. To use a different dedicated data directory or production port:

```sh
AI_OFFICE_DATA_DIR=/absolute/dedicated/ai-office-data AI_OFFICE_PORT=4311 npm start
```

Do not select a user home, an existing Codex home, or a production database directory as the application data directory. Host/Origin checks follow the actual bound port plus the local Vite origin. Port `0` chooses an OS-assigned port for isolated tests. Changing the backend port during Vite development also requires updating Vite's proxy target.

## Using the dashboard

1. Register an absolute **Git worktree root** you own and trust. Paths are canonicalized and validated. Estima and Pixel Office are excluded. No agent can select an unregistered path through HTTP.
2. Create a focused task, such as “Read README.md and explain the project.” Choose Codex 01 or Codex 02 explicitly. Creation saves an unsubmitted task in `queued` state.
3. Select the task and click **Start task**. Local login consumes your ChatGPT Codex allowance/credits according to your account settings. Start submits to the chosen agent’s persistent FIFO queue and may execute immediately. At most two tasks run, on different registered Git worktrees. A busy worktree waits for its lease.
4. Watch the event log. Interim assistant commentary is progress; **Final result appears only after `turn.completed`**. Thread IDs, task states, results, errors and events persist in local SQLite.
5. To continue after a backend restart, create a new task in the same repository, select the saved session in the Session menu, and Start. Its connection mode/model/context must match. The original native CLI transcript must still exist.
6. Use **Stop agent** to request SDK cancellation. The supervisor waits for process-group cleanup before releasing the worktree lock. During preflight, Stop can wait for the bounded metadata check. Cancellation cannot undo a completed provider request or guarantee zero additional allowance use.

The connection selection returns to local login on restart. Saved API sessions require explicitly choosing API-key mode again. Pre-1.2 sessions without a verified execution binding remain readable history but require a new session; no authentication context is guessed or migrated silently.

For read-only tasks, the changed-file summary is the worktree status at finish, including changes already present before the task. Write tasks provide a separate live Git review against their saved base commit. It is not an attribution claim. Read-only Codex tasks should not change files.

## Optional API-key mode

API billing is optional and never selected automatically. Supply a key only in the backend environment, restart, then explicitly choose **API key (separate billing)** in the dashboard. No key is entered or returned through HTTP.

For zsh, hidden terminal input:

```sh
read -rs 'CODEX_API_KEY?Optional API key: '
export CODEX_API_KEY
npm start
```

Even when this variable exists, local login remains preferred and its subprocess excludes API-key variables. API mode uses its own isolated application-owned Codex home. “Available” in API mode means a key is configured; the provider validates it on the first task. Do not paste credentials into task prompts. `.env` files are not loaded.

## Verification

Deterministic checks (no real inference or credentials):

```sh
npm run typecheck
npm test
npm run test:smoke
npm run build
npm run format:check
```

`npm run check` runs compilation, unit/integration tests, the HTTP/SSE smoke, and build. The fixture smoke uses the **real official SDK** with a deterministic CLI executable injected by local test code. It exercises login selection, streamed events/replay, final results, a complete backend/SQLite restart, and resume. There is no HTTP setting for a fake provider or arbitrary executable. Smoke servers use OS-assigned loopback ports and do not interrupt existing servers.

Production browser flow with the deterministic fixture:

```sh
npx playwright install chromium
npm run build
npm run test:browser
```

Credential-free native sandbox boundaries:

```sh
npm run test:sandbox
```

Metadata only, no inference:

```sh
npm run codex:inspect
```

**Explicit live production dashboard smoke — consumes ChatGPT Codex allowance/credits:**

```sh
npm run build
npm run test:dashboard:real
```

This drives the compiled dashboard through a browser against a real production backend without API-key variables. It creates a disposable Git repository, starts a real read-only task, observes SSE, restarts the backend, and resumes the saved native thread through the UI. It saves sanitized reports/screenshots and its private application SQLite database under `.ai-office/verification/`, then removes the disposable repository. The new native CLI transcript remains in its normal session store. No commits are created.

The earlier standalone SDK-only probe is available as `npm run test:real`; it does not test the dashboard. Live tests never run as part of `npm test` or `npm run check`. Some development tool sandboxes block loopback listeners, browsers, or nested OS sandboxes; run these checks from a normal local terminal when needed.

See [Phase 1.2 verification and limitations](docs/PHASE_1_2_DASHBOARD.md), [architecture](docs/ARCHITECTURE.md), [security/recovery](docs/SECURITY.md), and the historical [Phase 1.1 SDK report](docs/PHASE_1_1_CODEX_INTEGRATION.md).

Two manually assigned Codex agents are supported. Autonomous planning, automatic commits, pushes and merges are not implemented. Editing is restricted to explicitly authorized isolated-write tasks and review continuations.

## PHOSPHOR OS interface

The PHOSPHOR OS dashboard now has two real pixel workstations, independent event feeds, an explicit agent selector, a submitted queue and Focus Mode, keyboard navigation and optional CRT effects (off by default). The existing read-only Codex workflow is preserved. See the [v0.3 runtime and verification notes](docs/V0_3_MILESTONE_A.md) and [design and verification notes](docs/design/PHOSPHOR_OS.md) for layout, accessibility, screenshot commands and limitations.

## Queue, restart and allowance

Each agent runs one task at a time, with at most two active tasks per backend and 100 waiting submissions. Tasks are FIFO within their assigned agent; separate agents can make progress independently. Creating a task does not execute it. **Start task** authorizes queue execution, including after a restart. **Cancel queued task** removes a waiting submission without a model call. Stop affects only the selected active task.

Submitted work survives normal shutdown and resumes dispatch after the backend successfully listens. Running tasks are stopped on normal shutdown and recovered as interrupted after an unclean restart; they are never automatically retried. Create a new task assigned to the same agent and choose its compatible saved session to resume. Existing pre-v0.3 unsubmitted tasks remain unsubmitted. Schema 6 migration is transactional; older application versions refuse it. Review artifacts and feedback are preserved across restart and Keep/Reject.

Both agents use the selected backend authentication mode. A queued task retains its submitted mode and waits if it differs after restart; there is no paid fallback. Changing/refreshing the mode is blocked while either agent owns a run. Stale worktree/server leases require manual inspection and cleanup as described in [security and recovery](docs/SECURITY.md).

Two simultaneous turns consume overlapping ChatGPT allowance or explicitly selected API usage, plus two worker/CLI process groups and additional memory/CPU. The app does not predict dollars, remaining allowance or enforce an account-wide spend limit. Shared provider rate limits can affect both agents. Use one agent or cancel queued work to reduce concurrent usage; different AI Office data directories have separate concurrency budgets, while sharing worktree leases.
