# Office Experience V4

V4 replaces the layered V1/V2/V3 office implementation with one original isometric
studio, a complete profile roster, a contextual task inspector, a submitted queue,
and collapsed recent activity. This implementation was integrated into `main` via PR #36 (superseding draft PR #31); it is not a new
product version, tagged release, or deployment.

## Verified starting point

The sprint started from `main` at `b3f7ee9` and inspected PR #31 at
`105e8cf`. The local checkout was behind that PR and was fast-forwarded before
implementation. GitHub run [39890922882](https://github.com/vlovers/ai-office/actions/runs/39890922882)
failed Prettier on `src/web/pixel-art.tsx`. Browser checks were skipped after that
failure; the native policy job passed.

Rebuilding and running the PR exposed a browser assertion that expected history
details to remain expanded across reload, and an SSE shutdown bug that masked the
assertion with `ERR_STREAM_WRITE_AFTER_END`. The stabilization commit formats the
source, explicitly reopens history in the test, and guards ended SSE responses.
A new HTTP regression covers shutdown with an active fixture task and an open
stream. The rebuilt V3 browser smoke passed before the new scene was connected.

Source inspection also found duplicate rosters, fixed two-desk identity placement,
and accumulated scene styles. V4 removes the old artwork and scene rules instead
of adding another override layer. `pixel-art.tsx` retains the shared navigation
icon and compatibility exports; `office-art.tsx`, `office-scene.tsx`, `office.css`,
`office-layout.ts`, and `scene-state.ts` own the new scene.

## What changed

- A full-width cutaway studio with a consistent 2:1 projection, timber floor,
  windows, warm light, shelves/books, coffee station, lounge/meeting nook, plants,
  chairs, monitors, and original pixel characters. All artwork is local code.
- Four profile desks, distinct from the unchanged two-worker execution capacity.
  Profile order remains stable; selecting an overflow profile reveals it while
  retaining a displaced active worker where possible. The roster includes every
  visible profile. Archived profiles remain visible while they have an active task or are selected for saved-task inspection; new assignment remains disabled.
- Stable character palettes and accessories derived from profile IDs, shared
  between the room and roster. Selection also uses a stroke, focus outline,
  pressed semantics, text, and matching portrait, rather than color alone.
- Agent selection inspects the real active or selected/saved task. Task/session,
  assignment, and workflow approval actions lead to the existing tools. Queue and
  history buttons select the exact task ID, rather than only its owning agent.
- A checkpoint action opens the corresponding workflow, even when another workflow
  was selected in the board. Explicit inspection resumes paused workflow updates so the requested checkpoint is loaded. It never approves a checkpoint.
- Loading with unknown counts, initial connection failure, zero-profile, filtered-empty, disconnected-snapshot, failed, and saved
  completion states. Primary contextual actions are unavailable during a server
  disconnect. Workflow fetch failure has a separate notice and clears stale
  workflow indicators.
- Tab/Enter/Space and arrow/Home/End desk navigation, native roster buttons,
  reduced motion, the existing motion preference, and forced-color focus support.
  Narrow screens retain the room and provide larger roster targets.

## State truth

| Scene state          | Required evidence                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Idle                 | A real agent with no active execution or higher-priority queue/checkpoint/outcome                                |
| Preparing            | The agent's actual `preparing` reservation                                                                       |
| Queued               | A persisted submitted FIFO entry belonging to the agent                                                          |
| Working              | The agent's active task is `running`                                                                             |
| Thinking             | That running task's latest SDK progress item is a started/updated reasoning item                                 |
| Reviewing            | Exact agent/task match with a running workflow Reviewer stage, unless SDK reasoning is active                    |
| Waiting for approval | An active workflow stage awaits approval, or a blocked stage has actual evidence/report awaiting its result gate |
| Completed            | An actual selected/saved task completed; labels explicitly say saved result                                      |
| Failed/blocked       | An actual failed/interrupted task or blocked workflow stage                                                      |
| Stopping/offline     | Actual stopping state, missing/unavailable agent, authentication status, or server disconnect                    |

Active execution takes precedence over historical outcomes and other workflows.
An unsubmitted task's stored `queued` state does **not** imply a FIFO submission.
The inspector calls this “Task in view”; only a running assignment is called
“Current assignment.” No elapsed-time guesses, synthetic workers, percentages,
or simulated command activity are added. Idle breathing is decorative.

## Reused behavior and safety

The Fastify/SQLite manager, profile registry, two-worker scheduler, worktree leases,
Codex SDK transport, session resume, task-scoped SSE/replay, Git diff review,
revision-bound Keep/Reject/Request Changes, and workflow confirmation dialogs are
reused. Task snapshots still refresh every two seconds and workflow snapshots every
three seconds; active tasks use the existing SSE streams. No scheduler, permission,
provider, database schema, or execution-policy redesign was introduced.

The SDK has no interactive approval callback. The room's approval indicator refers
to persisted application workflow checkpoints. SDK operations requiring unsupported
escalation remain blocked. Inspecting an approval only navigates; explicit
revision/digest-bound confirmation still happens in the existing dialog.

## Reproduce verification

Use Node 24 and the installed project dependencies:

```sh
npm ci
npm run check
npm run format:check
npm run test:sandbox
npm run test:browser
npm run test:browser:office
npm run test:browser:write
npm run test:browser:studio
npm run test:browser:workflow
```

Build before browser suites. Native workflow/QA checks need a supported macOS
Codex sandbox. These commands use deterministic inference transport fixtures;
they do not call a model or use credentials. Native filesystem probes and QA
commands still execute through the actual sandbox. Run suites sequentially on a
loaded workstation; their timeout checks measure wall-clock time.

`test:browser:office` exercises loading, two idle profiles, zero profiles via actual
archival, six profiles/four visible desks, selected overflow identity, held SDK
reasoning, a second agent queued on the occupied worktree, exact queue-task
selection, cancellation, completion, provider failure, and simulated dashboard
transport failure. It captures each scene at 1440 and 390 pixels and checks overflow.
The original browser smoke also checks 320, 390, 768, 1024, and 1440 pixels, keyboard
navigation, motion settings, resume, two live workers, queue cancellation, and Stop
isolation. The workflow browser checks actual pending checkpoints, canceled/stale
confirmations, separate Coder/Reviewer/QA approvals, review reports, and contextual
navigation across two workflows.

Set `AI_OFFICE_BROWSER_ARTIFACTS` to a writable directory for scene and workflow
screenshots. CI runs the office suite and uploads `office-v4-browser` artifacts;
its native job retains `workflow-browser` evidence. The [selected screenshot
index](design/screenshots/office-v4/README.md) records the reviewed local captures.

## Local verification results (2026-10-23)

- `npm run check`: 176 unit/integration tests across 30 files, three HTTP/SSE smoke
  tests, TypeScript and production build passed. The complete unit/integration run
  took 368.68 seconds. An earlier overlapping run hit four wall-clock timeouts;
  the sequential rerun passed without widening limits or skipping tests.
- `npm run format:check` and `git diff --check` passed.
- All five browser suites passed. The final Agent Studio regression additionally
  preserves selection of an archived profile's saved task and keeps assignment
  disabled for that profile.
- `npm run test:sandbox` passed actual native filesystem-policy probes without
  inference. Workflow browser execution also passed its real native QA stage.
- Screenshots were inspected at desktop/mobile sizes; see the visual findings in
  the screenshot index. Exact-head GitHub check status remains visible on PR #31.

## Known limits and remaining MVP work

- The office is a profile viewport, not a physical scheduler or pathfinding
  simulation. Four desks are visible; execution capacity remains two. Overflow
  profiles are fully selectable in the roster.
- SVG room labels become small on mobile. The roster and contextual inspector
  provide the readable interactive interface; character movement between rooms
  and multi-room navigation remain outside this sprint.
- Workflow status can lag by its polling interval. If the workflow read fails,
  the room reports unavailable workflow status rather than preserving approval
  telemetry indefinitely.
- This sprint validates the SDK transport using fixtures and the real native
  sandbox. It does not establish a new paid/live-model verification result.
- Linux native workflow/QA success-path verification, Windows process supervision,
  long-running real-provider soak/recovery testing, and broader repository testing
  remain release gates. There is no automatic merge, push, or deploy from the app.
- Finish the first-run/recovery walkthrough, validate release documentation against
  actual tags, and obtain release approval before declaring the next MVP release.
  See the [MVP checklist](MVP_STABILIZATION_CHECKLIST.md).
