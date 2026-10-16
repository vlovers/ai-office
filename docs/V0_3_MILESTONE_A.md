# AI Office v0.3 — Multi-Agent Runtime, Milestone A

## Baseline and scope

`feat/multi-agent-runtime` starts from `origin/main` at `6b2cb00`, including merged PHOSPHOR OS (#1) and GitHub Actions validation (#2). Local work and earlier branches were preserved. This milestone implements exactly two manually assigned **read-only** Codex agents, without autonomous planning, editing, new providers or deployment.

The installed official `@openai/codex-sdk` remains pinned at **0.162.1**. Its installed declarations were inspected again: `startThread`, `resumeThread`, `runStreamed` and `TurnOptions.signal` remain the integration surface. No CLI installation, credential files, login state or permission preset was changed.

## Runtime decisions

- **Two independent slots:** Codex 01 and Codex 02 have distinct provider instances, application-owned worker homes, active sessions, SDK subprocess groups, cancellation flags and cleanup promises. The existing provider's one-run guard remains enabled. Shared authentication metadata is an explicit backend-wide selection; per-agent credentials are not introduced.
- **Durable, explicit submission:** task creation persists an assigned draft (`queued` without a queue record). Start validates readiness, agent/repository/provider ownership and resume context, then inserts a durable monotonic queue entry. Dispatch may begin immediately or after earlier work. This authorization survives restart. No legacy draft is silently submitted.
- **FIFO and bounds:** one run per slot; at most two simultaneous turns per backend, and at most 100 waiting submissions. FIFO applies within each assigned agent. A blocked head waits while another agent may progress. No priority system, preemption, reassignment, retries, worktree creation or autonomous decomposition is implemented.
- **Worktree exclusion:** canonical Git-directory identity is reserved before asynchronous work and protected by a shared OS-local lease under `/tmp/ai-office-worktrees-<uid>`, independent of TMPDIR and application data directory. Contention remains queued and retries roughly every 500 ms; it does not execute an SDK turn. The lease remains held through process reaping and result summarization. Existing/stale leases are never stolen. Only safe wait messages reach HTTP; owner PID/path records stay private.
- **Recovery:** queue dispatch starts only after the HTTP listener successfully binds. Graceful shutdown stops claimed runs concurrently and preserves unclaimed submissions. Interrupted runs become history after unclean restart and require a new task for explicit resume. A hard crash leaves server/worktree leases fail-closed until the operator inspects associated processes. Parent-disconnected workers abort their own SDK process group; unknown processes are never killed by recovery.
- **Authentication:** queue records retain their submitted mode and cannot silently change billing mode on recovery. Mode selection/refresh is excluded while either slot owns preparation/execution. Each turn still preflights the existing login and saved binding; API billing is explicit. Launcher replacement is atomic so simultaneous preflights do not truncate an executing launcher.

The backend remains bound to 127.0.0.1. Both agents use the same repository-scoped root-deny read-only profile, denied command networking, ignored inherited rules/configuration, user review routing and no SDK approval bypass. No arbitrary shell or database endpoint was added.

## SQLite and compatibility

Schema **3** adds `task_queue` and backfills session agent ownership in one immediate transaction, together with recovery and the schema-version change. Version 1/2 data, event history, results, native thread IDs and verified authentication bindings survive. Missing legacy ownership belongs to Codex 01. Unknown newer versions are rejected; downgrade is unsupported. Actual user runtime databases were not opened or migrated during development; migrations were tested in disposable fixtures.

A queue entry stores task ID, sequence, submission timestamp, chosen auth mode and optional saved session ID. It stores no credentials. Resume requires the same agent, registered repository, provider, authentication mode/context/runtime and compatible model. Old unbound sessions remain history.

`GET /api/dashboard` adds authoritative `agents`, `queue` and `concurrency`; `agent` is retained as the compatibility view of Codex 01. Existing task-specific SSE and event history routes remain. Task creation requires an explicit `agentId` of `codex-1` or `codex-2`; unknown assignments/extra fields are rejected. Start returns HTTP 202 for submission, not a promise of immediate execution. Stop can cancel a submitted queued entry without inference or stop its own running worker. A completed task is continued through a newly created task, as before.

## PHOSPHOR OS

Mission Control shows two individually selectable pixel-art workstations with independent status and SDK-derived reasoning activity. Preparing/waiting are labeled separately from SDK execution; no percentages or fabricated logs are shown. The task composer assigns a real agent, and the submitted queue displays actual FIFO work and safe wait reasons. The UI subscribes to both active task streams plus selected history, with separate event buffers.

Focus Mode selects the actual task belonging to the chosen agent; its Stop control addresses that agent only. Pending Stop requests are tracked per task, so another agent remains controllable while one worker cleans up. Session choices are filtered by repository, agent ownership and selected auth mode. CRT settings, independent scene-motion settings, reduced-motion suppression, keyboard workstation activation, visible focus, skip navigation and mobile layout remain intact. Screenshots from this milestone are private local fixture artifacts, not production model evidence.

## Verification

Verified on macOS arm64 / Node.js 24, with deterministic SDK/CLI fixtures in disposable Git repositories:

| Command                                    | Actual result                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                        | Passed                                                                                                     |
| `npm test`                                 | 37 unit/integration tests in 7 files passed                                                                |
| `npm run test:smoke`                       | 2 HTTP/SSE smoke tests passed                                                                              |
| `npm run build`                            | Server TypeScript and Vite production build passed                                                         |
| `npm run format:check`                     | Passed; no lint script configured                                                                          |
| `npm run test:browser` with local Chromium | Passed                                                                                                     |
| `npm run test:sandbox`                     | Native registered reads allowed; outside, secret and other-worktree reads denied; repository writes denied |

The browser run used:

```sh
TMPDIR=/private/tmp \
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/ai-office-playwright \
AI_OFFICE_SCREENSHOT_DIR=/private/tmp \
node --import tsx tests/browser-smoke.ts
```

The browser cache path is a local test setting; normal users can use their installed Playwright Chromium cache with `npm run test:browser`. Screenshots include `ai-office-v03-desktop.png` and `ai-office-v03-mobile.png` in the selected screenshot directory. Normal startup remains `npm ci`, `npm run build`, `npm start`; development remains `npm run dev` plus `npm run dev:web`.

Coverage includes:

- Concurrent actual SDK fixture processes on two registered worktrees, distinct persisted sessions/thread IDs and both task-specific SSE feeds. A preparation failure in one slot withholds raw runtime diagnostics and leaves the other running.
- Stopping A while B remains running and continues producing its own progress events; independent browser workstation/focus selection.
- Same-worktree contention within an application and against another actual OS application process; no second SDK execution until release.
- FIFO order within an agent, duplicate submission rejection, queue cancellation before execution, queue-capacity enforcement and independent provider-instance enforcement.
- Complete Store/provider/manager/auth reopen, pending queue recovery, saved agent-owned resume and rejection of cross-agent resume; unsubmitted tasks remain untouched.
- Version-1 and version-2 SQLite migration with history/binding preservation and interrupted-task recovery; malformed legacy metadata rolls back both DDL and ownership updates.
- Abrupt backend SIGKILL followed by confirmed orphan worker-group exit; the stale worktree lease still blocks new execution. Test-only cleanup removes only the disposable fixture lease after confirming its owner and worker group are gone.
- Existing authentication, security, sanitized failures, interim/final-result handling, CRT/motion preferences, keyboard paths, layouts from 320 to 1440 px and HTTP connection shutdown.

An initial orphan-group liveness probe was blocked with EPERM inside the development tool sandbox. The full suite passed outside that sandbox; normal local terminal/CI execution needs permission to inspect and supervise its own child process groups. Two obsolete single-agent test expectations were updated to reflect intentional waiting/queue-preservation semantics, and fixture thread IDs were made distinct across worktrees while preserving resume.

**No real model inference was performed for v0.3.** Tests exercise the official SDK with deterministic CLI fixtures; the native permissions probe runs no model and uses an empty auth home. These checks consumed no ChatGPT/API allowance and did not read authentication credentials. Historical Phase 1.2 live verification proves the earlier one-agent transport, not simultaneous live-model acceptance.

## Limits and resource implications

- Two simultaneous real turns, real-model cancellation under concurrent load and provider rate limits have not been live-tested in this milestone. Their SDK isolation/lifecycle is covered with fixtures. A separate explicitly authorized live acceptance run can consume allowance.
- Authentication mode is shared by both agents. A mode mismatch holds a queued entry, and authentication/provider failures may pause future dispatch while already-running work continues. A fingerprint does not identify a changed logged-in account in the same CLI home.
- Two active turns can use more memory/CPU and consume overlapping account allowance or separately selected API billing. There is no dollar estimate, token budget, remaining-credit telemetry, spend cap or global concurrency limit across separate AI Office data directories. Worktree exclusion is shared, concurrency quotas are per backend.
- Cancellation cannot undo sent requests or guarantee immediate provider stop/zero additional usage. Bounded authentication preflight can delay Stop. Deliberately detached external descendants are outside POSIX group supervision; stale leases and the native read-only sandbox remain essential.
- FIFO head-of-line blocking, queue expiry/priority, encrypted metadata, quotas/retention, worktree creation, editing, approvals UI, other providers and autonomous planning are out of scope. Task drafts/history remain unbounded local metadata.
- macOS native enforcement was verified. Linux has existing deterministic CI configuration, but this development run did not attest Linux native sandbox behavior; Windows remains unsupported. Browser verification used Chromium and is not a complete screen-reader audit.

No push, PR, merge or deployment was performed for this milestone.

## Changed-file manifest

| Group                           | Files                                                                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and schema              | `src/server/manager.ts`, `src/server/store.ts`, `src/server/lock.ts`, `src/server/app.ts`, `src/server/index.ts`, `src/shared/types.ts`                                                                                                                                     |
| Codex supervision and transport | `src/server/providers/codex.ts`, `src/server/providers/codex-worker.ts`, `src/server/providers/codex-auth.ts`                                                                                                                                                               |
| PHOSPHOR OS                     | `src/web/main.tsx`, `src/web/pixel-art.tsx`, `src/web/scene-state.ts`, `src/web/styles.css`                                                                                                                                                                                 |
| Verification                    | `tests/runtime.test.ts`, `tests/fixtures/runtime-child.ts`, `tests/fixtures/codex-fixture.mjs`, `tests/helpers.ts`, `tests/manager.test.ts`, `tests/store.test.ts`, `tests/scene-state.test.ts`, `tests/smoke.test.ts`, `tests/browser-smoke.ts`, `tests/native-sandbox.ts` |
| Version and documentation       | `package.json`, `package-lock.json`, `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/design/PHOSPHOR_OS.md`, `docs/V0_3_MILESTONE_A.md`                                                                                                                      |
