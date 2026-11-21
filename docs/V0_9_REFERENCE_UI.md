# Reference workspace UI — issue #201

This change starts from `55d6e793fdaa712bdc9eba6c0dd02fbdbd094e01` (PR #194).
The six images attached by the user on 2026-11-21 are the design reference. They
are conversation attachments, not repository assets. The desktop task layout
follows image 4; Settings follows image 6; the other images guide the shell,
blue accent, compact navigation, and panel treatment.

## Delivered behavior

- A 240px desktop sidebar, coherent stroke icons, functional repository selection,
  blue selection/focus treatment, and responsive navigation. The topbar explicitly
  reports that the repository branch is unavailable in the current dashboard API.
  Selecting a repository sets the task-composition context; workspace lists and
  statistics continue to cover registered repositories and retain their filters.
- Task-scoped Overview, Execution, Changes, Review and History sections. New links
  use `#task/<encoded-id>/<section>`; legacy session/review/workflow links and
  contextual Overview inspectors still work. Tab switches preserve keyboard focus;
  direct links and Back/Forward restore the task and section. Execution retains
  Start/Stop, resumable sessions, live logs, saved results and pinned configuration.
- Overview reads the saved prompt, state, assignee and timestamps. Its timeline
  displays persisted runtime state events received through the existing event
  stream. Working branches come from the existing isolated-worktree review API,
  with late response suppression on task changes and a visible unavailable state.
- Review reuses the existing ReviewCenter, including feedback, verification and
  keep/reject safeguards. Changes reuses TaskChangedFiles for read-only worktree
  summaries and links isolated write tasks to Review for actual patches.
- Settings has General, Repositories, Execution, Policies, Integrations, Appearance
  and Security subroutes. Authentication mode and repository registration use
  existing backend persistence. Display effects remain explicitly browser-local.
  Offline snapshots are labelled and authentication/registration are disabled.

## Deliberate availability boundaries

The current backend does not store structured acceptance criteria, task priority,
risk, dependency links, estimates, step percentages, linked PRs, request budgets,
notifications or automatic review preferences. Their absence is stated; no
invented values or editable lookalike controls were added. Review is disabled
until an isolated task is reviewable. Lead Agent and Project Context are omitted
because this branch does not provide functional persisted routes for them.
Workflows and Agents keep their existing operational components and use the
updated shell and surfaces. There is no new workflow-template or release button
without runtime support.

No execution, authentication, sandbox, approval, delivery or other backend policy
was changed. Application remote delivery remains inactive. PR #198 overlaps
`main.tsx` polling and several existing browser tests; preserve its conditional
polling and fixture isolation changes when reconciling branches. The separately
observed orchestration worktree uses backend/shared/project-workspace files that
this change does not edit. No AGENTS.md was present on the reviewed main or its
parent paths; proposed governance PRs remain separate.

## Reproduce UI evidence

Use Node 24.x, `npm ci`, `npx playwright install chromium`, and `npm run build`.
Then run:

```sh
AI_OFFICE_REFERENCE_ARTIFACTS=/tmp/ai-office-reference-evidence npm run test:browser:reference
```

The fixture serves the compiled React app through real Fastify routes and uses
real disposable SQLite records and temporary registered Git repositories. It
never starts a provider, makes a model call, or activates delivery. Each image
carries a fixture label. The suite covers six routes at 320, 390, 900, 1440 and
1920px, checks document overflow, and captures the four requested widths. Desktop
geometry assertions check the sidebar/detail placement and Settings columns.
It also exercises encoded task links, tab keyboard focus, reload, Back/Forward,
missing tasks, authentication persistence, repository errors and disconnection.

Committed screenshots under `docs/design/screenshots/v09/` are generated from
that fixture. They show real supported states, including absent backend fields,
rather than copying the mockups' invented task counts, profiles or progress.

| Screen                     | 1920                                                  | 1440                                                  | 900                                                  | 390                                                  |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Overview                   | [image](design/screenshots/v09/overview-1920.png)     | [image](design/screenshots/v09/overview-1440.png)     | [image](design/screenshots/v09/overview-900.png)     | [image](design/screenshots/v09/overview-390.png)     |
| Task Details (reference 4) | [image](design/screenshots/v09/task-details-1920.png) | [image](design/screenshots/v09/task-details-1440.png) | [image](design/screenshots/v09/task-details-900.png) | [image](design/screenshots/v09/task-details-390.png) |
| Settings (reference 6)     | [image](design/screenshots/v09/settings-1920.png)     | [image](design/screenshots/v09/settings-1440.png)     | [image](design/screenshots/v09/settings-900.png)     | [image](design/screenshots/v09/settings-390.png)     |
| Workflows                  | [image](design/screenshots/v09/workflows-1920.png)    | [image](design/screenshots/v09/workflows-1440.png)    | [image](design/screenshots/v09/workflows-900.png)    | [image](design/screenshots/v09/workflows-390.png)    |

Disconnected evidence: [Settings](design/screenshots/v09/settings-disconnected-1920.png),
[Task Details](design/screenshots/v09/task-details-disconnected-1920.png).

## Validation status

- Node 24.21.0; `npm ci`: passed (235 packages). Pinned Chromium installation verified.
- `npm run check:workflows`, `npm run test:workflow-pins`: passed (37 pin tests).
- `npm run lint`, `npm run typecheck`, `npm run build`, `npm run format:check`: passed.
- Supplemental ESLint with the existing syntax/security rules and TSX parsing:
  all 14 changed TypeScript files passed, zero errors or warnings. This supplements
  the main baseline lint script, which covers only Delivery files; #198 broadens it.
- Targeted UI/navigation/settings tests: 27/27 passed, including eight new tests.
- `npm run test:smoke`: 3/3 passed.
- `npm run test:sandbox`: passed actual native macOS policy checks.
- `npm run test:browser:reference`: passed 30 route/width combinations, tab and
  deep-link keyboard focus, settings persist/reload, error and disconnected tests.
- Full unit/integration and legacy browser verification are still being completed.
  The initial full run has timeouts in unchanged workspaces, workflow API and
  review tests. Initial legacy browser runs exposed old navigation/section
  assertions, updated in this branch. Native fixture reruns and comparison with
  the exact base are pending. These runs are not claimed green.
