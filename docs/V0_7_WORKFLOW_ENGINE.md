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

The safe creation API is `POST /api/workflows` with `repositoryId`, `coderAgentId`, `reviewerAgentId`, and optional `qaAgentId`. The server derives a pinned baseline from validated repository Git HEAD, and stores only an inert definition. Inspection uses `GET /api/workflows` and `GET /api/workflows/:id`. There is intentionally **no HTTP endpoint for workflow approval, start, finish or cancellation** in this checkpoint. Do not wire transition() directly to arbitrary browser input.

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
