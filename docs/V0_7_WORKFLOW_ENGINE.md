# v0.7 Workflow Engine — persistence checkpoint

This branch introduces the **first backend milestone**, not a functioning multi-agent pipeline.

## What is implemented

- Transactional metadata schema 9 with persistent workflow records.
- Coder (write) → Reviewer (read-only) → optional QA (read-only) linear definitions.
- Pinned agent revision and initial Git SHA (40 or 64 hex characters).
- Mandatory manual approval before each stage, including the first stage.
- Optimistic workflow version guard for concurrent UI actions.
- Explicit task binding and completion; stage failures or interruptions block further progression.
- Reopen/restart preserves the exact checkpoint.
- Tests for stale actions, unauthorized write profiles, revision drift, interrupted workflows and restart.

## Hard boundaries

WorkflowStore never calls a model, spawns a process, runs Git, requests host verification, or automatically dispatches queued tasks. Its transitions represent durable intent, **not** authorization. In particular, caller-provided revision strings are untrusted and must be recomputed by the orchestrator from the existing worktree identity and review revision.

The safe creation API is `POST /api/workflows` with `repositoryId`, `coderAgentId`, `reviewerAgentId`, and optional `qaAgentId`. The server derives a pinned baseline from validated repository Git HEAD, and stores only an inert definition. Inspection uses `GET /api/workflows` and `GET /api/workflows/:id`. Initial approval is supported through `POST /api/workflows/:id/approve-initial` with `{version, confirmed:true}`; it verifies the canonical repository, exact current HEAD and clean working tree on the server. It changes only the checkpoint state. **No execution, downstream approval, finish or cancellation HTTP endpoint exists** in this checkpoint. Do not wire transition() directly to arbitrary browser input.

## Integration still required before v0.7 is usable

1. Bind WorkflowStore to TaskManager submission and completion events.
2. Revalidate repository registration, workspace lease/identity and exact Git/review revision on every approval/start/finish.
3. Authorize requests using existing operator-confirmation mechanics. Stage approvals may not elevate effective agent permission or enable host verification.
4. Persist task binding atomically with queue submission; never run a task twice on restart.
5. On restart reconcile persisted running stages against the recovered task state and block until manual inspection; no automatic retries.
6. Expose validated status and approval actions to a workflow timeline UI.
7. Add HTTP/SSE/browser integration, migration backup fixtures and real macOS execution checks.

## Compatibility

Schema 9 is forward-only. Older AI Office versions must refuse to open metadata created here. Back up `.ai-office` before testing. Existing v0.6 tasks, agent versions, review records and queue entries are not modified by workflow creation.

## Acceptance for next milestone

A fresh Coder task must not launch before explicit approval, Reviewer must observe precisely the approved Coder revision, and QA must never run tests with unauthorized host permissions. End-to-end interruption/restart must not produce duplicate execution.

## Inert task binding

`POST /api/workflows/:id/bind-task` accepts `{version, taskId, confirmed:true}` for the approved initial Coder stage. The server revalidates the repository, current Git HEAD and clean checkout, then atomically associates an existing unsubmitted task with the stage. It does **not** enqueue, execute or grant host permissions. Downstream handoffs remain disabled pending review/worktree revision validation and TaskManager integration.

## Initial execution submission (experimental)

After initial approval and task binding, `POST /api/workflows/:id/submit-initial` requires `{version, confirmed:true, confirmedWrite:true}`. The server revalidates the repository and current clean Git HEAD before invoking the existing TaskManager start preflight. The workflow's bound task cannot use the generic task start endpoint. Workflow stage transition and queue insertion share one SQLite transaction: if execution configuration pinning fails, both are rolled back. TaskManager still enforces local connection readiness, profile availability, provider write capability, workspace roots and write confirmation. No automatic Reviewer/QA handoff is enabled. This endpoint must be exercised on disposable repositories with configured isolated-write roots before v0.7 release.

**Limitations:** the synchronous Git check precedes queue submission; pre-execution repository leases and identity are still revalidated by TaskManager. Completing a queued task does not yet advance workflow state. Shutdown/restart must block unresolved workflow stages rather than retry them automatically. Full end-to-end behavior remains unverified.
