# v0.7 — Coder, Reviewer and QA workflow

The implementation was merged into `main` via [PR #24](https://github.com/vlovers/ai-office/pull/24). It is **not a tagged release or deployment**. The earlier Draft PR #22 was superseded and closed. See [validation and live trial evidence](V0_7_VALIDATION.md).

## Working behavior

The dashboard creates a workflow from an unsubmitted isolated-write Coder task and pinned Reviewer/optional QA profiles. Every stage needs an operator decision. The initial baseline is a server-observed Git HEAD, not a browser-supplied hash.

1. **Approve baseline → bind task → Start Coder.** Coder writes only in its isolated worktree. Dispatch rechecks the clean primary checkout and exact approved HEAD under repository leases.
2. **Capture → approve Coder evidence.** Review Center computes a fingerprint bound to workspace identity, bytes/metadata inventory, configuration and review epoch. Approval releases the next checkpoint; it does not launch Reviewer.
3. **Approve Reviewer input → prepare snapshot → Start Reviewer.** Preparation builds a bounded changed-file evidence bundle, full source copy and separate remote-free Git context. Each durable preparation step revalidates the input; partial preparation can be inspected and continued without dispatch. Submission verifies the complete chain under repository, Coder worktree and runtime leases.
4. **Inspect → approve Reviewer result.** A real Codex SDK session reads the isolated snapshot. Its completed task is a blocked checkpoint until the operator approves the exact persisted report digest. QA stays pending before that approval.
5. **Approve QA command → Start QA.** The operator selects a server-configured command ID and sees its exact argument vector. The server pins canonical executable identity, arguments and timeout. QA executes that vector in the native read-only sandbox. It never asks the model to invent shell commands and never calls host verification.
6. **Inspect → approve QA result.** Passing QA produces another blocked result checkpoint. The workflow becomes completed only after final approval. With no QA stage, approving the Reviewer result completes it.

The same timeline, results and actions appear in Review Center for the Coder task. Reports render as text, including malicious HTML. Refresh/reload preserves server checkpoints. Failed or interrupted runs require cancellation/inspection and a new workflow; there is no hidden retry or replacement thread.

## Isolation boundary

A read-only prompt and `chmod` are not the security boundary. Before submission and execution, AI Office probes the **actual Codex native sandbox** without credentials or inference: an allowed read must succeed, while an outside read, secret read, write and loopback network request must fail. Reviewer probes the selected supported CLI; QA uses the CLI supplied by the pinned dependency. Missing/unsupported policy means no downstream execution. No unsandboxed fallback exists.

Reviewer uses the existing Codex SDK worker, sanitized shell environment, restricted filesystem profile, disabled network/web search, ignored user/project execution rules and process-group supervision. Snapshot sessions cannot be resumed through the generic task API. Source, primary checkout, other worktrees, credentials and Git metadata are not writable by Reviewer or QA. A task bound to a workflow cannot use ordinary task start as an alternate gate.

The full source copy contains additions and modifications and omits tracked deletions. The Reviewer prompt also receives the approved bounded diff as untrusted JSON, so deleted content and changed lines remain reviewable. Full-source hashes must agree with the changed-file bundle. Runtime verification checks all Git metadata before running Git, rejecting changed hooks, config, refs, index and external object indirection. Git initialization has no templates, remotes, inherited global configuration, hooks or filters.

Source capture rejects symlinks, path escapes, ambiguous/case-fold collisions, sensitive paths, unsupported entries, files over 1 MiB and projects over 32 MiB / 2,000 visible files. The changed-file bundle is separately bounded. These limits fail closed; automation never silently omits an unsafe file.

The native sandbox protects against agent processes. A hostile host administrator or another arbitrary process with the same OS identity is outside this boundary. AI Office retains private copies and leases, checks hashes and directory identity before dispatch and after process cleanup, and rejects tampering at later approval gates. It does not claim a same-UID-proof filesystem snapshot.

## Safe QA commands

Configure `AI_OFFICE_VERIFICATION_COMMANDS` as JSON mapping IDs to argument arrays, for example:

```json
{ "source-check": ["/bin/sh", "-c", "test -f README.md && echo source-check-passed"] }
```

The first argument must be an absolute executable path. The browser can select an ID; it cannot supply executable paths, arguments, environment variables or a new timeout. The plan pins the executable's canonical path and filesystem identity as well as its argument vector. Any command/configuration change invalidates approval. Timeout is 60 seconds by default, with an allowed maximum of 120 seconds; captured output is bounded to about 128 KiB. A successful command with empty output is still a passing QA result.

QA gets a private empty CLI home and no backend credentials, proxies, `NODE_OPTIONS` or user hooks. The sandbox denies writes even inside the snapshot, including cache/coverage output, and denies network. Suites needing package installation, downloads, external dependencies outside permitted runtime paths or writable build/cache directories can fail. They require a separately designed isolated runner, not enabling `AI_OFFICE_ALLOW_HOST_VERIFICATION`. The workflow never converts its QA approval into host verification rights.

Stop, timeout, output limit, worker disconnect and application shutdown terminate the supervised process group. Uncertain process cleanup quarantines the task and retains leases for manual inspection.

## Persistence and recovery

Workflow definitions, pinned profile revisions, task configurations, preparation provenance, queue intent, execution identity and report digests live in SQLite schema **9**. Task creation, read-only configuration pinning, queue insertion and downstream stage binding share a transaction. Successful task/result persistence is transactional too. Optimistic versions and shared leases prevent duplicate submission or approval.

On restart, queued workflow tasks lose their dispatch intent and become interrupted before the queue starts; unrelated FIFO entries retain their relative order. Unrelated queued session continuations retain their original session ID, thread ID, server-only connection binding and pinned execution configuration; recovery does not silently replace a session or disclose its binding in the Dashboard. Tasks that were running are interrupted by task recovery. A persisted completed Reviewer/QA task without its atomic result checkpoint leaves the workflow blocked for inspection, while a persisted failed or stopped task retains a failed stage (not a misleading interruption). The next stage is never automatically dispatched. Recovery preserves snapshots and reports, never steals an unknown lease, resumes a snapshot thread, treats a partial source copy as runnable or infers successful QA from a missing process. Reopening metadata again is idempotent. The restarted Dashboard (`GET /api/dashboard`) exposes the persisted task states and only the surviving unrelated queue entries; Workflow Timeline and Diagnostics (`GET /api/workflows/:id/timeline` and `/diagnostics`) expose the same blocked, interrupted, or failed checkpoint without offering a replay action. These endpoints report durable metadata, not live process health or permission to resume. The restart API contract is covered by `tests/workflow-restart-dashboard.test.ts` using a fresh Store and TaskManager without a live Codex process.

A separate deterministic recovery-commit-gap regression in `tests/workflows.test.ts` models an abrupt process death **after Store has committed its task interruption but before WorkflowStore has reconciled the running stage**. It writes that exact intermediate SQLite checkpoint, reopens a fresh Store, verifies the Workflow becomes blocked without reapproval or replay, preserves unrelated FIFO queue entries, and reopens once more to prove idempotence. This exercises the cross-transaction recovery boundary without a production crash-injection switch or live Codex credentials. It does not establish multi-process lease safety or remote provider crash recovery.

The production Dashboard reconnect contract is also exercised by `tests/browser-workflow-restart.ts` (part of `npm run test:browser:workflow`). It serves the compiled UI from a separate backend process, seeds disposable SQLite checkpoints, kills that process, starts another process against the same database and checks that the **same open Playwright page** refreshes without a forced reload. It verifies Reviewer interruption, failed and unapproved QA, surviving FIFO queue order (including a queued session continuation with the same session/thread ID and pinned execution configuration), non-disclosure of its server-only connection binding, and idempotence across a second restart. The fixture deliberately has no available Codex authentication, so it proves process/UI recovery and absence of automatic dispatch under unavailable authentication—not a live Codex/macOS execution trial. The second restart also waits for a new browser-originated successful API response: a still-visible cached `blocked` label alone does not prove reconnection. On failure, the test preserves a screenshot and bounded backend stderr/page-error diagnostics in `AI_OFFICE_BROWSER_ARTIFACTS` (or a printed temporary evidence directory locally). The CI workflow uploads those artifacts even when the browser job fails. The real-provider gate remains `npm run test:real:workflow` with explicit operator opt-in.

Schema 8 migrates forward without changing existing tasks, profiles, configurations or independent queues. Back up the closed `.ai-office` directory before upgrading. A v0.6 binary must refuse schema 9. Restore a matching **metadata and workspace** backup when rolling back; do not point older code at current metadata. Existing experimental v0.7 runtime candidates created with the former config-only Git fingerprint fail the stronger verification; cancel and recreate those workflows rather than trusting or silently rewriting their provenance.

## Lifecycle and cleanup

Snapshots remain available after success, failure, interruption and restart for inspection. Cancel stops a non-running active/blocked workflow without deleting the Coder workspace. Stop running tasks first.

`cleanup-artifacts` is a separate, explicitly confirmed action on a completed/cancelled workflow. It holds repository/worktree/runtime leases, persists cleanup intent, and removes only UUID-owned evidence/source/runtime directories under the configured roots. It preserves Coder files, branches, task history and reports. Interrupted/failed cleanup remains a durable manual-inspection state; there is no automatic orphan garbage collection or lease stealing.

## HTTP actions

Every mutation uses strict JSON, same-origin/Host enforcement and an optimistic `version`. Approvals/submissions/cleanup require `confirmed:true`; initial Coder submission also requires `confirmedWrite:true`.

| Action                                           | Additional input                            | Effect                                         |
| ------------------------------------------------ | ------------------------------------------- | ---------------------------------------------- |
| `POST /api/workflows`                            | repository and agent IDs                    | Pin inert stages and server Git HEAD           |
| `approve-initial`, `bind-task`, `submit-initial` | task ID for binding                         | Authorize and submit Coder                     |
| `capture-coder-evidence`                         | optional explicit `replace:true`            | Record/refresh versioned evidence              |
| `approve-coder-evidence`, `approve-reviewer`     | exact evidence `revision`                   | Separate human handoff gates                   |
| `prepare-reviewer`                               | none                                        | Continue bounded preparation; never dispatch   |
| `submit-reviewer`                                | none                                        | Probe, validate, atomically queue SDK Reviewer |
| `approve-reviewer-result`                        | exact report `digest`                       | Accept report; open QA gate or complete        |
| `approve-qa`                                     | evidence `revision`, configured `commandId` | Pin QA plan                                    |
| `submit-qa`                                      | none                                        | Revalidate and queue sandboxed QA              |
| `approve-qa-result`                              | exact report `digest`                       | Complete workflow                              |
| `cancel`                                         | none                                        | Cancel a non-running workflow                  |
| `cleanup-artifacts`                              | none                                        | Remove owned snapshots after terminal state    |

Action paths are `/api/workflows/:id/<action>`. `GET /api/workflows`, `/:id`, `/:id/timeline` and `/:id/results` expose inspection and saved reports. `GET /api/workflows/qa-commands` exposes configured choices. The timeline's `downstreamExecutable` indicates prepared runtime availability, **not** authorization or a successful native preflight. Every submission repeats its checks.

The granular prepare/verify/bundle inspection endpoints remain available for recovery diagnostics. Their `runnable:false` responses are intentional: diagnostics do not grant execution authority. Use the dedicated submission endpoints.

## Supported local CLI selection

The SDK/CLI policy is pinned to **0.162.1**. An automatically updated global CLI is rejected until its policy is explicitly validated and the integration upgraded. `AI_OFFICE_CODEX_EXECUTABLE` can select an absolute operator-owned path to the supported CLI, including the CLI shipped with the project, while keeping the same local ChatGPT login. This is server configuration; HTTP callers cannot change it. There is no automatic API-billing fallback.

Official background: [Codex SDK](https://developers.openai.com/codex/sdk), [Codex security](https://developers.openai.com/codex/security). The installed SDK types and native policy tests determine the exact supported implementation.

## Verification

```sh
npm run typecheck
npm test
npm run test:smoke
npm run build
npm run format:check
npm run test:sandbox
npm run test:workflow:native
npm run test:browser:workflow
```

Native success paths and the complete browser journey run in the mandatory macOS CI job with no inference/credentials. Linux runs portable integration, security, migration and HTTP tests; set `AI_OFFICE_NATIVE_TESTS=1` only on a Linux machine with supported native sandbox primitives to exercise its success paths. An unavailable Linux sandbox blocks real execution; CI does not substitute a fake capability success.

`npm run test:real:workflow` is an explicit opt-in live trial. It creates a fresh disposable repository, performs exactly one real Coder and one Reviewer turn using the supported bundled CLI and local ChatGPT model, runs real sandboxed QA, applies each gate, verifies the primary checkout is unchanged, and preserves SQLite plus `verification.json`. No model retries, merge, commits of generated changes, release or deployment occur. Preparation commits only the initial disposable fixture. This trial validates transport, isolation and orchestration on a small task; it is not a benchmark of review quality or large repository support.
