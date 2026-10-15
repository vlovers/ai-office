# AI Office

A local-first dashboard for one human-directed Codex agent. Register a local Git worktree, create a read-only review task, watch live progress, stop it, and resume the saved thread after restarting the backend.

**Phase 1.2 prefers your existing ChatGPT Codex CLI login. No `CODEX_API_KEY` is needed for local-login tasks.** API-key mode remains an explicit, separately billed option. Local authentication never falls back to API billing.

Agent execution stays **read-only**. The SDK has no interactive approval callback, so edits, destructive operations, pushes, merges, and database operations remain blocked. Results can propose changes for manual review.

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
2. Create a focused task, such as “Read README.md and explain the project.” It is assigned to Codex 01 in `queued` state.
3. Select the task and click **Start task**. Local login consumes your ChatGPT Codex allowance/credits according to your account settings. Only one agent/task runs at a time.
4. Watch the event log. Interim assistant commentary is progress; **Final result appears only after `turn.completed`**. Thread IDs, task states, results, errors and events persist in local SQLite.
5. To continue after a backend restart, create a new task in the same repository, select the saved session in the Session menu, and Start. Its connection mode/model/context must match. The original native CLI transcript must still exist.
6. Use **Stop agent** to request SDK cancellation. The supervisor waits for process-group cleanup before releasing the worktree lock. During preflight, Stop can wait for the bounded metadata check. Cancellation cannot undo a completed provider request or guarantee zero additional allowance use.

The connection selection returns to local login on restart. Saved API sessions require explicitly choosing API-key mode again. Pre-1.2 sessions without a verified execution binding remain readable history but require a new session; no authentication context is guessed or migrated silently.

The changed-file summary is the worktree status at finish, including changes already present before the task. It is not an attribution claim. Read-only Codex tasks should not change files.

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

No autonomous planning, multiple parallel agents, editing, automatic commits, pushes or merges are implemented.
