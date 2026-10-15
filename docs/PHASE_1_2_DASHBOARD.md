# Phase 1.2 — ChatGPT-authenticated dashboard

## Implemented behavior

The production dashboard can now create/start a real read-only Codex task with the existing local ChatGPT CLI login and **without `CODEX_API_KEY`**. Local login is the default even when an API key is configured. API mode requires an explicit UI choice; neither failed preflight nor provider authentication failure can select it automatically.

The UI displays **Available**, **Authentication required**, or **Connection error**, with a mode selector and Refresh connection control. There are no key/password/token inputs or login/export endpoints. Connection responses contain only mode/status/message/check timestamp and safe option labels. No account/email identifiers, auth-home/CLI paths, environment contents, or credential payloads are sent to the browser.

The single-agent guard, registered-root validation, cross-process worktree lease, repository-scoped read-only permission profile, and loopback binding are preserved. No editing or parallel-agent planning was added.

## Transport and authentication

- `providers/codex-metadata.ts` promotes the Phase 1.1 metadata client into backend code. It launches the existing CLI over private stdio, calls `initialize`/`initialized`, `account/read` with `refreshToken:false`, and `model/list`. Unsolicited server requests get no approval. Application code never opens authentication/configuration files or calls token-export/login/logout methods.
- `providers/codex-auth.ts` owns connection state and task preflight. Only `chatgpt` account metadata enables local mode. An absent, API-key-only, or other account reports Authentication required; process/version/connection failures report Connection error. The current runtime gate is CLI **0.162.1**, matching the pinned SDK and tested permission behavior. No installation is changed.
- Before each local task, the connection is rechecked. The CLI child gets only the selected existing HOME/CODEX_HOME paths and a minimal PATH; API-key/access-token/cloud/database variables are excluded. The worker itself keeps an application-owned private home. The CLI owns its normal authentication and any internal token refresh.
- The fixed server-owned launcher forwards execution to the unchanged CLI with `--ignore-user-config --ignore-rules`. The application supplies the tested read-only profile, root deny, command networking/web-search denial, disabled project-doc import, and `approvals_reviewer=user`. No bypass/full-access mode or automatic reviewer is enabled. The browser cannot choose executables, environments, configuration, sandbox flags, or paths outside registered repositories.
- Optional API mode uses the bundled pinned runtime and an isolated `.ai-office/codex-home`, with an explicitly configured backend environment key. “Available” there means configured, not yet provider-validated. Local login never inherits that key or uses that home.
- Local checks on page polling use cached status; Refresh and task preflight perform fresh metadata queries. Metadata can describe a cached login whose tokens later fail at inference; an actual unauthorized/expired-login error changes status to Authentication required and fails the task without fallback. Raw provider diagnostics are not exposed.

The manager serializes connection changes/checks against task starts. Mode changes are rejected during an active run. Start remains human-directed; creating a task does not execute it.

## Persistence and restart

SQLite schema version **2** adds a private `session_bindings` table. A binding records connection mode, a non-secret execution-context hash, requested model, and runtime version. It stores **no credentials**. Public session metadata includes only the safe mode/model labels alongside the existing thread ID. The context hash and runtime/home selection are not returned in dashboard payloads.

A resume requires the same registered repository/provider, chosen authentication mode, context fingerprint, runtime version, and still-available saved model. A changed model default does not silently change a saved session's model. The fingerprint identifies selected CLI/home paths/version; it is not an account-ID binding and cannot independently detect a user changing the logged-in account in the same CLI home. Native CLI/provider checks still apply.

After restart, local login is preferred again. API sessions require explicitly selecting API mode. Existing metadata/history is retained. Pre-1.2 sessions without a verified binding are not assigned a guessed authentication context; start a new session for them. The Phase 1.1 probe's separate verification database is not automatically imported into the dashboard.

Completed tasks/results/events and native thread IDs survive a backend restart. Running/stopping tasks recovered from an unclean restart are marked interrupted. The native Codex transcript must remain in the same CLI home; SQLite's ID alone cannot reconstruct deleted native history.

## Results and cancellation

The SDK's `item.completed` for an `agent_message` can be **interim commentary**. The provider now streams these messages as progress, buffers the latest assistant message, and publishes a final result only after **`turn.completed`**. A regression assertion verifies that multiple completed assistant messages yield one final result.

Stop sends SDK abort through the supervised worker. Remaining POSIX process-group members are killed after the grace period; the lease stays held through cleanup. A Stop arriving during authentication preparation may wait for its bounded metadata probe (version command: 5 s; individual metadata RPCs: 15 s). Cancellation does not undo provider requests or guarantee zero additional credit/allowance use. Actual live cancellation was not tested in this phase; deterministic tests exercise a CLI process that ignores SIGTERM and Stop during preparation.

On shutdown, SSE responses end, the manager cleans up the agent, then Fastify closes all remaining HTTP connections before SQLite/server-lease cleanup. This fixes shutdown hanging on browser connections. Tests never stop the user's existing server; all smoke backends bind to OS-assigned loopback ports.

## Real model verification

**This was a real production dashboard/browser test, not a mocked model. It consumed ChatGPT Codex allowance/credits.** It launched the compiled production entry point with API-key variables excluded, used the UI to select local login/register/create/start, observed actual SSE events, restarted the actual backend process with the same SQLite data, and resumed through the UI.

Successful run started **2026-10-15T21:47:05.565Z** (2026-10-16 in Europe/Kyiv).

| Check                     | Observed result                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SDK / existing CLI        | 0.162.1 / 0.162.1; no installation or login changes                                                                   |
| Auth                      | Existing CLI-owned ChatGPT login; no API-key environment, options or fallback                                         |
| Model                     | `gpt-6.1-sol`, requested by the provider and confirmed in native persisted thread metadata                            |
| First UI task             | Completed in **8.402 s**, including UI/preflight; successfully read a random marker from the disposable README        |
| Resume UI task            | Completed in **4.854 s** after graceful backend restart; recalled the same marker in the same saved thread            |
| Thread ID                 | `<redacted-thread-id>` on both turns                                                                                  |
| Streaming                 | Three successful browser SSE connections across task/history selections; real thread/progress/result events persisted |
| SQLite/native persistence | Completed results/history survived reopen; native transcript non-ephemeral; saved session ID and thread ID unchanged  |
| Repository                | README bytes and Git status unchanged; disposable worktree removed after the test; no commits                         |
| Browser                   | No page errors; desktop/mobile screenshots inspected; no horizontal overflow at 390 px                                |
| Errors in successful run  | None                                                                                                                  |
| End-to-end run duration   | **17.207 s**, including startup, restart, metadata check and cleanup                                                  |

Model metadata is the configured/persisted model, not physical backend routing attestation; the SDK does not expose per-event model telemetry or token-level text deltas.

Evidence (private and Git-ignored) is under `.ai-office/verification/dashboard-real-1792100825565/`: `report.json`, `desktop.png`, `mobile.png`, and the application's `data/office.sqlite`. These are application/test artifacts, not copies of the CLI auth store. The new native thread transcript remains in its normal CLI session store.

### Earlier live attempts and corrections

Two earlier attempts also consumed Codex allowance and are retained separately rather than counted as successful full smoke runs:

1. `dashboard-real-1792100590573` (9.824 s): the agent read the marker, but the UI/test mistook interim commentary for the final answer. The test assertion failed and its cleanup stopped the task. Fixed final-result handling to wait for `turn.completed`; added a multi-message regression assertion.
2. `dashboard-real-1792100692520` (30.961 s): the first task completed successfully in 7.429 s, but backend shutdown exceeded the test's grace period and the test killed **its own** backend. Enabled complete HTTP connection cleanup. A separate no-inference production lifecycle probe then exited with code 0 and removed its lock. The subsequent full live run above passed restart/resume.

Failed-attempt data is forensic evidence only; do not reuse those test data directories or remove stale locks without inspecting their recorded owners. No existing user server was terminated. A separate early fixture smoke also found port 4310 already in use, prompting ephemeral test ports and dynamic same-origin checks.

## Deterministic verification and commands

```sh
npm run typecheck
npm test
npm run test:smoke
npm run build
npm run format:check
npm run test:browser
```

The unit/integration suite covers mode selection with an optional API key, missing/wrong login, expired-login-style runtime failure, metadata/unsupported-version errors, environment filtering, mode/context mismatch on resume, no private connection data in HTTP, strict request rejection, cancellation/concurrency, legacy migration, and session/event persistence. The fixture HTTP/SSE smoke creates a fresh backend/provider/auth service/SQLite connection before resume. The browser fixture checks explicit mode selection and shutdown with browser connections still present. These deterministic passes are not counted as live model calls.

The opt-in live command (requires a Playwright Chromium browser and consumes ChatGPT usage) is:

```sh
npm run build
npm run test:dashboard:real
```

Live tests are excluded from `npm test` and `npm run check`. `npm run test:real` remains the historical standalone SDK probe. `npm run codex:inspect` is metadata-only. The [README](../README.md) has exact normal/development startup commands with no API key required.

## Remaining limits

- Read-only only, one agent, no interactive SDK approval UI, no autonomous planning or editing.
- CLI version gate is intentionally strict. Keyring/enterprise/gateway configurations other than the tested local setup may fail closed when execution config is ignored. No CLI is downgraded to make it pass.
- Cached account metadata is not a guarantee of remaining entitlement, connectivity or token validity. Runtime failures update status; no billing or remaining-credit amount is inferred.
- Live API-key inference, live cancellation and Linux execution were not tested. Windows is unsupported.
- POSIX supervision does not contain deliberately detached processes like a VM; cancellation is best effort at the provider boundary. Unclean-termination leases remain fail closed.
- Metadata/results/transcripts are plaintext local files protected by OS permissions, not encrypted storage. Do not enter secrets in prompts or register credential-bearing/production data directories.

No Estima or Pixel Office repositories were read or changed. No production databases, commits, pushes, or merges were involved.
