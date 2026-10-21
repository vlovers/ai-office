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

## Reviewer/QA handoff — implementation contract (not yet implemented)

This is the acceptance contract for the next integrated vertical slice in **this PR**, not a
claim that downstream agent execution already works.

### Evidence is not a Git commit

The Coder evidence revision is a Review Center **content fingerprint**. Passing it as a
Git SHA, checking out the initial repository HEAD, or giving Reviewer access to the
mutable Coder worktree would silently inspect the wrong output. A valid handoff must
be derived from the approved Coder workspace, including tracked changes, added and
deleted files, and must be reproducible independently of subsequent Coder edits.

### Snapshot and identity invariants

1. Resolve repository and Coder worktree identities again from trusted server metadata
   immediately before snapshot creation. Reject worktree replacement, symlink escape,
   changed Git common directory, changed base commit, and unexpected dirty repository
   state. Do not trust a client-provided path, hash, or workspace identifier.
2. Acquire the same OS-local repository/worktree leases used by Review Center and
   hold them over the whole fingerprint verification **and snapshot creation**. Never
   release the lock between checking a revision and reading its bytes (TOCTOU).
3. Recompute the complete content fingerprint under the lease and require an exact
   match with the approved evidence revision and the workflow's optimistic version.
   Reject missing/unreadable files and entries with unsupported types; do not resolve
   symlinks outside the authorized root.
4. Materialize a private, disposable, **immutable snapshot** which includes additions,
   modifications and deletions relative to the approved base. The original checkout
   and Coder worktree must not be used as the Reviewer's writable workspace.
5. Persist the snapshot's identity, content digest, source evidence revision, source
   workspace identity, approved workflow version, creation time, and provenance before
   a downstream task can be queued. Create the checkpoint and dispatch intent
   atomically; never infer readiness from a partially written snapshot.
6. On every downstream start/resume, revalidate the stored snapshot identity and
   content digest. Any mismatch blocks the workflow and requires a new human review.
   After restart, an uncertain running/queued downstream task is **interrupted** and
   never silently retried.

### Capability and permission fence

- Reviewer and QA must always use pinned read-only profiles. No write escalation,
  shell-based copy, host verification, network expansion, or token/secret inheritance
  from the Coder task. Verify actual Codex SDK filesystem controls on macOS/Linux;
  a prompt saying "read-only" is not a sandbox security boundary.
- Prefer a snapshot reader with explicit allowlisted files and no process-spawning
  capability if OS-enforced read-only sandbox semantics cannot be demonstrated.
- Workspace lease ownership, snapshot cleanup, cancellation and failure recovery must
  be explicit. Unknown lease owners after a crash fail closed for manual inspection.
- Never dispatch Reviewer just because a user clicked **Approve Reviewer**: approval
  authorizes only the exact snapshot digest and pinned agent revision checked at
  submission time.

### Disposable end-to-end acceptance matrix

- **Tracked additions, modifications, deletions:** Reviewer sees the approved bytes.
- **Coder worktree changed:** Deny stale handoff and dispatch.
- **Replaced worktree or escaping symlink:** Fail closed; preserve source.
- **Git lease held:** Reject snapshot creation and queue entry.
- **Simultaneous approvals:** Exactly one succeeds.
- **Pinned profile changed:** Deny unauthorized elevation.
- **Snapshot tampered:** Block launch.
- **Crash before queue claim:** Interrupt; require reapproval.
- **SDK read-only policy unavailable:** No model run.
- **QA requests host command:** Separate authorization required.
- **Cleanup fails:** Preserve source and record error.

### Release gates and batching

Implement snapshot construction, lease-held verification, durable handoff record,
read-only runner adapter, restart handling, and integration/browser tests as **one
coherent feature batch** within PR #22. Keep Reviewer/QA execution denied until the
whole batch passes on the exact head SHA. Separately require a supervised live
model test with explicit authorization; fixture tests alone do not prove the SDK
provides native OS-level read-only isolation. Squash the feature history at merge
only after review and approval; do not create a PR per endpoint or test.

## Read-only workflow timeline API

`GET /api/workflows/:id/timeline` returns a presentation projection of the durable
workflow: stage state, pinned agent revision, task binding, captured revision,
and the next available **operator checkpoint**. The response explicitly reports
`downstreamExecutable: false` for all workflows in this release. A suggested
`nextAction` is never an authorization grant: every actual mutation endpoint
rechecks versions, repository identity, Git leases, evidence and permissions.
The endpoint does not run a model, construct a snapshot or enqueue work.

## Reviewer handoff inspection (non-executing)

`POST /api/workflows/:id/inspect-handoff` accepts a pinned `{version,revision}`
after explicit Reviewer approval. It re-runs Review Center verification under
its existing repository lease, checks exact worktree identity, revision and
file count, and reports file inspection availability without returning file
contents. Sensitive, oversized, binary or unavailable entries require manual
inspection. The response always declares `snapshotCreated:false` and
`downstreamExecutable:false`: inspection creates no immutable snapshot, no
model session and no task queue entry. This endpoint is a diagnostic, not a
security grant or a replacement for lease-held snapshot construction.

## Handoff manifest validation (fail-closed preflight)

Before any snapshot may be considered, `assessHandoff` rejects empty or
oversized change manifests, traversal, absolute and ambiguous paths, Unicode
case-fold collisions, unsupported Git change statuses and unavailable content.
The inspector returns `eligible` and machine-readable `reasons`, but always
returns `snapshotCreated:false` and `downstreamExecutable:false`. A clean
manifest is **necessary but not sufficient**: only a future lease-held native
snapshot operation can authenticate file bytes and prove immutable isolation.

## Browser workflow monitor (read-only)

The Workflow Timeline panel lists persisted workflows and displays each pinned
stage using `GET /api/workflows/:id/timeline`. The panel is explicitly
read-only: it has no approval, write, queue or model launch button. An operator
may refresh status and inspect the next checkpoint without accidentally
converting a UI suggestion into execution authority. Reviewer/QA remain fenced.

## Experimental changed-file evidence bundle

`materializeEvidenceBundle` creates a bounded, private evidence directory with
file hashes, deletion markers and a JSON manifest. It validates paths and
symlinks, checks evidence fingerprints before and after reading, and removes
partial bundles on failure. **It is not yet wired to HTTP or workflow storage.**
The caller must hold repository and workspace leases across both verification
calls and materialization. A chmod read-only directory is not a true immutable
filesystem or a Codex security boundary. It must not be passed to Reviewer as
an execution workspace. Durable provenance, restart cleanup and native read-only
execution are still required.

## Bundle verification and cleanup

The evidence bundle module also provides `verifyEvidenceBundle` to rehash
captured contents and `removeEvidenceBundle` to clean up UUID-named bundles
without following a replaced bundle root. Cleanup explicitly restores write
permissions to the private bundle directory so non-root operators can delete
completed evidence; no arbitrary directory is accepted. These functions do
not confer immutability or grant Reviewer execution permissions.

## Leased evidence bundle capture (experimental)

`POST /api/workflows/:id/capture-bundle` requires the approved Reviewer
checkpoint, optimistic workflow version, exact Coder evidence fingerprint and
`confirmed:true`. TaskManager obtains the same repository/worktree lease as
Review Center and holds it across workspace validation, content review,
creation of a bounded file bundle and a SQLite provenance checkpoint. The
stored Reviewer bundle identity, directory, digest and file count are versioned.
Concurrent or repeated captures fail closed; failed checkpoints remove the
new bundle. A bundle is **not** an immutable source tree or an executable
Reviewer workspace. A process failure after bundle creation but before SQLite
commit can leave an orphan bundle for manual recovery; automatic cleanup and
snapshot verification before real execution remain future work. The response
always reports `runnable:false` and never queues a model.

## Bundle verification before downstream use

`POST /api/workflows/:id/verify-bundle` revalidates the Reviewer checkpoint,
locks the repository, verifies Coder worktree identity and current fingerprint,
then checks persisted bundle provenance against the complete on-disk manifest.
It returns `runnable:false` even when verification passes. It cannot create
Reviewer tasks and does not elevate permissions. This is a diagnostic safety
check, not an immutable sandbox or resumable execution authorization.

## Recovery inventory (read-only)

`GET /api/workflows/bundles/audit` inspects persisted Reviewer bundle
checkpoints after a restart. Each capture is revalidated against the current
workflow version and Coder workspace through the existing lease-held verifier.
The endpoint returns verified/invalid counts but never starts agents, repairs
permissions or deletes unknown filesystem data. A failed verification is
reported as invalid and requires operator inspection. Orphan bundle garbage
collection remains intentionally disabled until crash-consistent reconciliation
is implemented.

## Full source candidate (not executable)

`createReviewerSourceCandidate` prepares a bounded copy of Git tracked and
visible untracked source files in a private directory, under a lease held by
its caller. It rejects symlinks, case-fold path collisions, obvious sensitive
paths, files above 1 MiB and projects above 32 MiB / 2000 files. It compares
file inventories and the external revision check before and after capture.
It is not wired to workflow execution, and its read-only permission bits do
not provide OS-level isolation, protection from the same UID, or provenance
recovery. This preparation layer does **not** permit Reviewer execution.

## Source provenance attached to approved Reviewer checkpoint

`POST /api/workflows/:id/prepare-reviewer-source` requires `confirmed:true`,
an existing approved evidence bundle and a matching workflow version. It uses
the shared worktree Git lease, verifies evidence hashes and the live Coder
revision, creates a full Git-visible source candidate, verifies its digest and
atomically records its provenance in the Reviewer stage. Duplicate preparation
fails closed, and partial copies are cleaned up on ordinary errors. Restart
and abandoned-directory reconciliation remain unfinished. It does **not**
launch Reviewer and always returns `runnable:false`.

## Persisted source verification (execution disabled)

`POST /api/workflows/:id/verify-reviewer-source` verifies the previously
persisted full source checkpoint against the current worktree revision, the
approved evidence bundle and both on-disk manifests. The check holds a Git
lease, rejects stale workflow versions and reports `runnable:false`. This
survives metadata reopening, but is not an independent OS sandbox and does
not provide restart-safe Reviewer execution.

## Remote-free Git staging (experimental, not an agent runner)

`stageReviewerGitContext` validates the approved source candidate, builds
an independent local Git repository with no remote, disabled hooks and a
restricted Git environment, and checks its inventory and clean commit.
It revalidates the source and revision before returning. Failures remove
partial runtime directories. `removeReviewerGitContext` refuses arbitrary
filesystem paths. A Git staging directory does **not** constitute a sandbox,
does **not** permit model execution, and is not connected to TaskManager
yet. In particular, no Reviewer agent is started and there is no auto-resume
or automatic approval.

## Connected Reviewer Git staging

`POST /api/workflows/:id/prepare-reviewer-runtime` requires explicit
confirmation and the optimistic workflow version. Under the repository Git
lease it verifies both manifests and the Coder revision, prepares a local
remote-free Git context with hooks disabled, and atomically records the
runtime commit and source digest. Replays and stale versions are rejected.
If the database update fails, the staged context is removed. This endpoint
never launches Codex or changes agent queues; the result remains
`runnable:false`. Full sandbox verification and process recovery are not
implemented yet.
