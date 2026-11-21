# Repository planning, workflow templates and context (#202)

Implemented from main `55d6e79` (PR #194). PR #198 is open and was inspected;
its pending isolation/cache/deadline/lease changes are not merged here. No
provider, scheduler, sandbox configuration, authentication, review approval,
remote Delivery or release policy is changed.

## Supported behavior

`/orchestration.html` is a functional integration preview. The exported
`ProjectWorkspace({ repositoryId, section: 'lead' | 'templates' | 'context' })`
component can be mounted in the #201 shell. It uses existing styles and the
existing task-scoped WorkflowBoard. Global navigation, CSS, Task Details and
Settings remain owned by #201. The interface agreement is recorded on
[#201](https://github.com/vlovers/ai-office/issues/201#issuecomment-7065095343).
The preview demonstrates functionality; it does not claim visual signoff or
completion of #201's reference-aligned shell.

- Save an **operator-authored** structured proposal and conversation notes.
  Edit stage assignments and optional minute estimates; dependencies/entry
  conditions match the executable Coder → Reviewer → optional QA engine.
  A prerequisite check validates current profiles, connection, clean repository,
  context revision and authorized roots without creating tasks.
- Select a maximum of one/two workers. This existing workflow is sequential
  (effective parallelism one) within the unchanged global scheduler cap of two.
  An optional **estimated time budget** requires every stage estimate and bounds
  their sum. Estimates are not measured costs, deadlines or billing limits.
- Explicitly confirm **Create workflow for approval**. A SQLite transaction
  creates one existing workflow and an unsubmitted Coder task, links the plan,
  and optionally pins context bytes into its prompt. Lost-response retries and
  simultaneous creation do not create another workflow. Creation grants no
  execution authority and performs no model calls or workspace writes.
- Use the existing explicit baseline approval and **Start Coder** write
  confirmation. Then inspect/capture/approve Coder evidence, approve Reviewer
  input, prepare/submit the verified read-only snapshot, and approve the exact
  report. Optional QA requires a separate operator-selected server-configured
  command, submission and result approval. Completion counts only approved
  stages; failure/interruption/blocked/queue states derive from stored tasks and
  workflow checkpoints. Stop remains the existing task control. There are no
  automatic retries or hidden stage submissions.
- Create, edit, duplicate, archive/restore repository templates. Instantiation
  snapshots a template/version into a new editable proposal. Editing/archiving
  a template does not mutate previous proposals or runs.
- Edit/save/discard context, inspect history, or explicitly restore a revision
  as a **new** revision. Brief, requirements, constraints and roadmap are typed
  text fields. Provenance records operator source, time and restored revision.
  No file import, arbitrary path reader, external fetch or inferred context is
  implemented. Context enters an execution prompt only after an explicit
  attachment choice and confirmed run creation, as untrusted reference JSON.
  It cannot change any runtime permission or authorize push, merge or deployment.

Model generation is deliberately disabled: `modelPlanning:false` and a disabled
Generate action explain that no model planner is integrated. Conversation notes
are attributed to **You**, never a scripted assistant. There are no invented
agent online states, preset recent runs, monetary costs or autonomous release
stages. Pause, monetary budgets, triggers/schedules, branch switching, release,
push, deployment and merge are unsupported. There are no feature flag environment
variables or switches that bypass these limitations.

## Typed HTTP contract

Types are in `src/shared/orchestration.ts`. Every path below is prefixed with
`/api/repositories/:repositoryId`. All mutations use strict JSON under the
existing Host/same-origin/content-type policy. UUIDs are scoped by repository;
unknown or cross-repository records are 404. Optimistic conflicts are 409.

| Method/path                                | Body / effect                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /orchestration`                       | Plans, templates, derived runs, current context, actual read-only branch/HEAD, capability availability |
| `POST /plans`                              | `{proposal}`; inert operator-authored draft                                                            |
| `PUT /plans/:id`                           | `{version,proposal}`; only before materialization                                                      |
| `POST /plans/:id/messages`                 | `{version,text}`; append operator note (100-message limit)                                             |
| `POST /plans/:id/propose`                  | `{version}`; always 503/unavailable; no inference or mutation                                          |
| `POST /plans/:id/validate`                 | `{version,contextRevision}`; advisory current prerequisites, no authority                              |
| `POST /plans/:id/run`                      | `{version,contextRevision,confirmed:true}`; atomic inert existing workflow/task, not execution         |
| `POST /workflow-templates`                 | `{proposal}`                                                                                           |
| `PUT /workflow-templates/:id`              | `{version,proposal,archived}`                                                                          |
| `POST /workflow-templates/:id/duplicate`   | `{version}`; independent copy with provenance                                                          |
| `POST /workflow-templates/:id/instantiate` | `{version}`; editable plan, no execution                                                               |
| `PUT /context`                             | `{revision,content:{brief,requirements,constraints,roadmap}}`                                          |
| `GET /context/history`                     | Repository-only append-only revisions                                                                  |
| `POST /context/revert`                     | `{revision,targetRevision,confirmed:true}`; append restored content                                    |

Workflow controls keep their existing `/api/workflows/:id/...` endpoints and
version/evidence/digest/write confirmations. The preview mounts WorkflowBoard
with the exact Coder task ID, so another repository's workflow is not selected.
`ProjectWorkspace` keys its complete internal state by repository ID, aborts old
reads on unmount, rejects mismatched repository responses, and locks mutations
after read/mutation failures until successful refresh. It never automatically
retries a mutation. Local drafts are discarded on repository switch. Refreshes
do not overwrite an in-progress context edit; a stale save fails its revision
check. Unsaved proposal changes disable workflow creation.

## Persistence and recovery

Schema **10** transactionally adds `plans`, `workflow_templates` and
`project_context` tables and repository indexes/foreign keys. Schema 9 upgrades
without altering task/session/profile/workspace authority. Version 9 binaries
refuse version 10; preserve a closed metadata/workspace backup before upgrading.
Newer unknown schemas still fail closed. A rollback requires matching metadata
and workspace backups, not opening the new database with an older binary.

Plans never own a second queue or runner. Existing workflow recovery interrupts
submitted/running workflow tasks, removes their queue intent and preserves their
plan/template/context/report links. Reopening again does not advance state or
replay execution. Unsubmitted proposals and approval checkpoints survive restart
without dispatch. Plan definitions freeze after materialization; create another
proposal for a new run. Context and template edits cannot rewrite task prompts.

The snapshot and history endpoints currently return all repository metadata;
pagination/retention for large plan/conversation/context collections is a known
limit. The existing task runtime timeout and cleanup quarantine still apply;
PR #198's preparation-wide deadline is pending, not claimed here.

## Verification

Use Node 24.x and `npm ci`, then `npm run check` and `npm run format:check`.
New integration coverage is `tests/orchestration.test.ts`; existing dynamic-agent,
runtime, workflow-execution, migration and security tests remain authoritative for
the reused scheduler and native gates. The browser entry is built by the normal
multi-page Vite build. Run its real HTTP/SQLite/native-sandbox journey with:

```sh
node --import tsx tests/browser-orchestration.ts
```

It uses the real installed SDK transport with deterministic fixture inference,
real filesystem/SQLite/HTTP and native Reviewer/QA sandbox probes. No credentials
or paid model calls are used. Native denial never becomes a fake success.
Screenshots at 1440, 1920 and 390, plus `verification.json`, are written beneath
`AI_OFFICE_BROWSER_ARTIFACTS` or the OS temporary `ai-office-v09-orchestration`
directory. The fixture banner/provenance are explicit. No session transcripts,
local databases, fixture UUIDs or machine-specific screenshots belong in Git.
