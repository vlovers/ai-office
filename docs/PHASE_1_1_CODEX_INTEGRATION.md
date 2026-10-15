# Phase 1.1: real Codex integration

Historical report: the dashboard integration described below as pending was subsequently implemented and verified in [Phase 1.2](PHASE_1_2_DASHBOARD.md). The original Phase 1.1 observations/results remain unchanged.

## Finding

**The installed official TypeScript SDK can use this machine's existing ChatGPT-authenticated Codex CLI session without an API key.** This was verified with a real model task and a subsequent resume turn. Phase 1's isolated-home/API-key-only dashboard is an application design choice, not a limitation of the SDK.

There is no need to upgrade, downgrade, replace, log out, or log in again to the working CLI for this result. The application must offer authentication as an explicit choice; API billing must never be an implicit fallback for a missing/expired ChatGPT login.

## What was inspected

On 2026-10-15:

- Installed `@openai/codex-sdk`: **0.162.1**, inspected `package.json`, exported TypeScript declarations, implementation and README.
- Existing CLI resolved from PATH: `bin/codex (relative to the active Node.js installation)`, reports **codex-cli 0.162.1**. Its entry file's SHA-256 was identical before and after the live test. No installation or user configuration files were edited.
- Generated the installed CLI's app-server TypeScript protocol into `/private/tmp/ai-office-phase11-protocol` and inspected the account, thread, and approval types. Generation did not modify the installation.

Actual SDK surface:

| Capability        | Installed behavior / limit                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start             | `Codex.startThread(options)`; lazy thread allocation on the first turn                                                                                           |
| Resume            | `Codex.resumeThread(id, options)`; uses the CLI's persisted transcript                                                                                           |
| Stream            | `Thread.runStreamed(input, { signal })`, async JSONL thread/item/turn events                                                                                     |
| Cancel            | `AbortSignal` forwarded to child-process spawn; SDK cleanup sends termination, without a public PID/hard-kill API                                                |
| Runtime selection | `codexPathOverride` selects an existing executable without installing it                                                                                         |
| Auth              | No `apiKey` option is required when the launched CLI has a usable login; `env` can select the existing home while omitting API-key variables                     |
| Sandboxing        | `read-only`, `workspace-write`, or structured named permission profiles through config overrides                                                                 |
| Approvals         | Policy configuration exists, but there is no bidirectional approval callback, pending-request responder, or interactive approval transport in the TypeScript SDK |
| Model telemetry   | SDK thread events do not include the actual model identifier. The test records requested and persisted model metadata separately                                 |

The SDK launches `codex exec --experimental-json`, appends config and working-directory options, and streams stdout. Supplying `env` replaces environment inheritance. Omitting both `apiKey` and API-key environment variables lets the CLI own authentication. SDK type literals include some retired/legacy settings; the app must not treat every exported literal as a current recommended security policy.

## Authentication compatibility and secret handling

The metadata probe used app-server **`account/read` with `refreshToken: false`**, after `initialize`/`initialized`. It reported account type **`chatgpt`**. The probe emitted only the account type and `requiresOpenaiAuth`; email, workspace identifiers, and account payloads were not printed or persisted. It did not call a login, logout, token-export, token-refresh, or legacy include-token method.

No application code opened, parsed, printed, or copied authentication files or tokens. The installed CLI used its own existing login normally, including any refresh it performs internally. This distinction is necessary: successful authenticated requests require the CLI itself to access its credentials, but AI Office does not need to handle them.

The inference subprocess environment contained only the existing `HOME`, existing `CODEX_HOME` when set, and a minimal PATH including the existing Node executable. `OPENAI_API_KEY`, `CODEX_API_KEY`, access-token variables, unrelated cloud/database credentials, and proxies were not forwarded. No API key was supplied through SDK options. Preflight refused inference unless the metadata account type was `chatgpt`; there is **no API-key fallback**.

The SDK doesn't expose the CLI's `--ignore-user-config` or `--ignore-rules` switches. The test therefore used a tiny disposable launcher that adds only those two switches before calling the **unchanged existing CLI**. The normal authentication home remained selected; the launcher did not copy or link any authentication data. Its location was outside the test repository, and it was removed after the test. Execution used AI Office's repository-scoped read-only permission profile, command network denial, disabled web search, disabled project-doc import, and an empty shell environment except PATH. Existing user execution rules or broad sandbox settings were not inherited into the task.

This verifies this machine's current login/storage configuration. It does not prove compatibility with every keyring backend, enterprise auth policy, remote host, or platform. If ignoring user config makes a different machine's credential store unavailable, fail visibly; do not switch to API billing, copy auth files, force a login mode that may log out the user, or weaken permissions.

ChatGPT authentication consumes the account's Codex allowance/credits according to its settings. The probe did not measure money charged or remaining entitlement. It did not require OpenAI Platform API billing. See [official authentication documentation](https://learn.chatgpt.com/docs/auth) for the distinction between ChatGPT and API-key access.

## Real SDK smoke: actual results

This was a **real model test**, not the deterministic CLI fixture. Start timestamp: **2026-10-15T12:19:33.991Z**.

| Observation                | Actual result                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication             | Existing CLI-owned ChatGPT login; no API-key environment or SDK key                                                                                            |
| Requested model            | `gpt-6.1-sol`, selected from `model/list`'s available default                                                                                                  |
| Persisted model / provider | `gpt-6.1-sol` / `openai`, returned by `thread/read` after both turns                                                                                           |
| Real thread ID             | `<redacted-thread-id>`                                                                                                                                         |
| First turn                 | **11.475 seconds**, completed; a successful read-only command read the random marker from the disposable README                                                |
| First-turn stream          | `thread.started` ×1, `turn.started` ×1, `item.started` ×1, `item.completed` ×3, `turn.completed` ×1                                                            |
| Resume turn                | **5.043 seconds**, completed; a new SDK client resumed the saved ID after SQLite was closed and reopened, and recalled the marker without rereading the README |
| Resume stream              | `thread.started` ×1 with the same ID, `turn.started` ×1, `item.completed` ×1, `turn.completed` ×1                                                              |
| Persistence                | Task completion/events/thread ID survived SQLite reopen; native thread was non-ephemeral and discoverable through app-server metadata                          |
| Repository                 | Newly initialized disposable Git worktree, no commits; README bytes and Git status unchanged; removed after verification                                       |
| Total duration             | **17.659 seconds**, including preflight and persistence checks                                                                                                 |
| Model/provider errors      | **None** in the successful authenticated test                                                                                                                  |
| Installation               | Existing CLI entry fingerprint unchanged                                                                                                                       |

Model qualification: `thread/read.model` is persisted configuration metadata, not physical backend execution attestation. The SDK does not expose per-event model routing telemetry; the report does not infer the model from the model's own answer.

Local evidence is retained under `.ai-office/verification/`, ignored by Git:

- `real-sdk-1792066791608.json`: sanitized structured report.
- `real-1792066774877.sqlite`: local task/session/event metadata. Event records contain event types, not raw transport diagnostics. Final task results contain only this disposable test's model output.

The native CLI's new test transcript remains in its normal session store so persistence can work. Its auth store was never copied. Only this new thread was queried; other conversation history was not enumerated or read.

An initial **metadata-only** attempt inside the development tool sandbox exited before handshake; raw stderr was intentionally withheld. The same probe passed with tool permission outside that sandbox. This was a local environment restriction, not a model/authentication failure. The real authenticated SDK invocation then succeeded on its first attempt. No model retry or paid fallback was used.

## Reproducing the checks

Metadata only, no inference:

```sh
npm run codex:inspect
```

Explicit live test, consumes ChatGPT Codex allowance/credits:

```sh
npm run test:real
```

This creates a disposable worktree, runs two bounded read-only turns, reopens local SQLite, confirms the same native thread and model metadata, records sanitized evidence, and removes the worktree/launcher. It stops before inference if the CLI reports an API-key account or no ChatGPT login. It never runs as part of `npm test`, `npm run check`, or the deterministic smoke suite.

The real test covers SDK authentication, streamed **item-level** events, completion and resume. It does not claim token-level text deltas, dashboard HTTP/SSE coverage with a real model, real cancellation, denied-action prompts, or editing. Those are separate checks. Phase 1's fixture smoke still covers HTTP/SSE/dashboard mechanics and deterministic process-failure/cancellation behavior; its passes are not counted as real model runs.

## Safe permission architecture

Keep the tested SDK adapter for read-only analysis. Expose authentication as `local-cli-chatgpt` versus explicitly selected `api-key`; let the CLI own OAuth. Do not import tokens into SQLite or accept credentials/custom executables over HTTP. Keep the existing OS sandbox and process-group supervision.

For future editing, create a **separate isolated worktree per write agent/task** from a user-selected base revision, after explicit permission to create that worktree and modify files. Record its canonical root, Git directory, and ownership lease. Do not automatically make a base commit, share worktrees, grant access to the user's original working tree, push, merge, or delete the worktree during cleanup. Preserve artifacts for review. Uncommitted base changes need an explicit policy rather than an implicit commit/copy.

Use workspace-write semantics only within that owned worktree, with root access denied except necessary runtime paths, auth/secret/Git metadata protections, and command network denial. Prefer the equivalent narrow named profile because this app's root-deny boundary is stricter than the legacy workspace-write preset. Do not combine a profile with legacy `--sandbox` settings that override it. No full-access mode, automatic reviewer, session-wide approval, or broad extra directory is acceptable.

**Workspace-write plus `on-request` is not an approval for every change.** In-sandbox commands and patches can execute without a prompt; a delete inside a writable tree may already be allowed. Therefore switching the existing SDK to workspace-write does **not** satisfy the requirement for manual destructive-operation approval.

There are two safe paths:

1. **SDK proposal/review/apply (recommended first):** keep inference read-only. Require a structured, bounded file-change proposal; render exact diffs and base hashes. An application-owned applier changes only explicitly selected files after user approval. Validate canonical containment, symlinks, unchanged base content, file types and limits; reject credential/Git paths and arbitrary shell hooks. Add/update can be approved as a concrete patch; deletions, overwrites, renames, executable-mode changes and binary replacements need explicit individual review. Applying a patch must not run package scripts, formatters, migrations, Git hooks, pushes or merges. This approval is an application action, not a simulated SDK approval.
2. **Bidirectional app-server provider:** the installed protocol supports real `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `turn/interrupt`, and user-routed review. Implement it as a separate adapter behind `AgentProvider`; retain the official SDK for analysis. Prefer private stdio, not a public listener. Pin generated protocol types to the verified CLI version. Surface concrete pending requests and reply only to an explicit user decision, correlated to that thread/turn/item/request. Default deny on timeout, browser disconnect, stale requests, process restart, or unknown request types. Do not return `acceptForSession`, approve policy amendments, or widen grant roots. Approval callbacks alone still do not guarantee interception of every in-sandbox destructive action; prove enforcement with negative tests before granting writes, or use proposal/apply instead.

The installed protocol schemas, not documentation examples alone, establish these candidate API names. No app-server write/approval flow was executed during this phase. `grantRoot` is marked unstable in the installed file-change approval schema. A user-controlled approval UI is feasible, but its secure editing behavior is **not yet verified or implemented**. The [official SDK guide](https://learn.chatgpt.com/docs/codex-sdk) directs rich approval clients toward [app-server](https://learn.chatgpt.com/docs/app-server).

## Exact required Phase 2 changes

Implement these before any autonomous multi-agent scheduler:

| Area / file                                             | Required change and acceptance criterion                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New `src/server/providers/codex-auth.ts` and `index.ts` | Explicit auth strategy (`local-cli-chatgpt`, optional `api-key`). Resolve/validate the local CLI server-side, check version and account metadata, exclude key env in ChatGPT mode, and refuse account/method mismatch without fallback. Never read/copy auth files or change login/install state. Probe availability must drive readiness rather than `Boolean(CODEX_API_KEY)` |
| `codex.ts`, `codex-worker.ts`, launcher utility         | Separate the worker's private application home from the selected CLI-owned authentication home; only the CLI receives the selected auth-home paths. Preserve the tested ignore-config/rules behavior and fail closed if the installed CLI cannot enforce it. Keep agent tools unable to access that home. Do not simply forward the entire parent environment                  |
| `shared/types.ts`, `manager.ts`, `main.tsx`             | Display authentication mode, readiness/error, model and last verification; mark API mode as separately billed. Persist session auth mode, CLI version/home identity and model so a resume cannot silently change account mode or execution context. Clear pending approvals on interruption                                                                                    |
| `store.ts` and migrations                               | Add versioned metadata for auth strategy/model, worktree identity/base revision, write authorization, proposal hash/status, and one-shot approval records. Persist no tokens. Replace hardcoded provider/session defaults where necessary                                                                                                                                      |
| Repository/worktree service                             | Create one owned worktree per writer only after explicit permission. Validate excluded roots and canonical paths, acquire a cross-process lease, protect original/Git/credential paths, and preserve dirty work on stop/failure. Never auto-commit to make worktree creation possible                                                                                          |
| Proposal/apply service and strict endpoints             | Add `GET /api/tasks/:id/proposal` and `POST /api/tasks/:id/apply` with proposal/base hashes and selected operations. Reject stale content and unsafe paths; return exact changed files. Require explicit deletion/destructive-operation consent. No arbitrary patch command or shell endpoint                                                                                  |
| Optional new `CodexAppServerProvider`                   | Add actual server-request routing and pending approval state, version-matched generated types, private stdio supervision and `turn/interrupt`. Use user review only. Never label the SDK adapter interactive or manufacture approval events                                                                                                                                    |
| Unit/security tests                                     | Verify missing/expired/wrong auth mode never falls back to API; no secret env leakage; no approval on reconnect/restart; path/symlink and stale-hash rejection; deletes require concrete consent; two writers cannot share a worktree; stop preserves changes                                                                                                                  |
| Opt-in real acceptance tests                            | Re-run the ChatGPT read-only SDK probe; test real dashboard events with selected auth; then test only explicitly authorized harmless add/update in a disposable isolated worktree. Validate actual denied-action and interrupt behavior before describing write support as safe                                                                                                |

Current shipped dashboard behavior is unchanged apart from a clearer readiness message: it still uses its isolated API-key adapter and does not yet select local CLI authentication. Use the explicit Phase 1.1 probe for the verified existing-login path. This report does not claim that the proposed Phase 2 features already exist.

No Estima or Pixel Office commands or agents were run. No production databases were accessed. No existing CLI installation/configuration was changed. No commits, pushes, or merges were performed.
