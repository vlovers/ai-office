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

The safe creation API is `POST /api/workflows` with `repositoryId`, `coderAgentId`, `reviewerAgentId`, and optional `qaAgentId`. The server derives a pinned baseline from validated repository Git HEAD, and stores only an inert definition. Inspection uses `GET /api/workflows` and `GET /api/workflows/:id`. Initial approval is supported through `POST /api/workflows/:id/approve-initial` with `{version, confirmed:true}`; it verifies the canonical repository, exact current HEAD and clean working tree on the server. It changes only the checkpoint state. **Coder execution and explicit Coder/Reviewer approvals now exist**, but no downstream Reviewer/QA execution, generic finish or cancellation HTTP endpoint is available. Do not wire transition() directly to arbitrary browser input.

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

## Terminal reconciliation (fail-closed)

The TaskManager finalizer calls `WorkflowStore.reconcileTerminals()` after persisting terminal task state. For completed Coder tasks, the workflow and stage become **blocked**, not approved or ready for Reviewer. Failed, stopped and interrupted tasks likewise block the chain. A separate provenance verifier and explicit operator approval are required before any downstream handoff can be safely enabled. This is intentional: task completion is not proof that the intended Git revision was produced. The transition is idempotent and transactional; unfinished queue tasks are not treated as completed.

## Restart queue invariant

Before the restored queue dispatcher starts, schema initialization reconciles workflow-linked stages. A submitted workflow task still in `queued` state is changed to `interrupted` and its `task_queue` entry is deleted in the same SQLite transaction that blocks the workflow. This prevents pre-approved tasks from silently executing after a backend crash. Do not remove this constraint when introducing auto-handoff or retry policies. A new operator decision and fresh repository revision verification are required.

## Coder output evidence capture

`POST /api/workflows/:id/capture-coder-evidence` requires `{version, confirmed:true}` after a completed Coder task has been reconciled to a blocked workflow. It calls the existing Review Center path with its workspace identity validation, repository lease and exact 64-character content revision. It persists a versioned `{workspaceId, revision, fileCount, recordedAt}` checkpoint alongside the Coder stage. Mismatched task, workspace or revision is rejected. Repeated capture without an explicit refresh flag is rejected. When the captured worktree changes, the operator may call the same endpoint with `{version, confirmed:true, replace:true}` after inspecting the new Review Center diff. This creates a new checkpoint revision, preserves up to 32 superseded evidence records for audit, and leaves the workflow blocked until separate approval. An unchanged revision, mismatched workspace, stale version or exhausted audit history is rejected. Recording evidence **does not** approve the diff or unlock the Reviewer: that needs an explicit human decision and a robust read-only snapshot handoff.

## Explicit Coder review approval

`POST /api/workflows/:id/approve-coder-evidence` accepts `{version, confirmed:true, revision}`. The API re-runs the existing Review Center workspace validation, lease acquisition, diff snapshot and content-revision calculation and refuses stale or mismatched evidence. The stored Coder stage becomes completed and the Reviewer enters `awaiting_approval`; no task is created, no worktree is mounted for Reviewer, and no model is run. The content revision is a Review Center fingerprint, **not** a Git commit SHA. A separate verified read-only handoff and explicit Reviewer authorization still must be implemented and tested.

## Downstream execution fence

Reviewer/QA submission is explicitly forbidden by both `TaskManager.start` and `WorkflowStore.enqueueApprovedTask` until a leased immutable read-only snapshot runner is available. Approving a Reviewer checkpoint is **not** execution authority. The approved Review Center fingerprint is not an ordinary Git commit, so running against the registered repository HEAD would inspect different content. Keep both checks when the snapshot runner is introduced; replace them only alongside a disposable-repository E2E demonstration and capability audit.
