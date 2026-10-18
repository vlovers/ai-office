# Code Review Center (v0.5)

Open a completed, failed or stopped isolated-write task in the existing task workspace.
The Code Review Center loads Git review automatically; **Refresh Git review** repeats it.
Read-only task summaries remain unchanged. No model call occurs when opening review.

1. Inspect the task, branch, worktree and base under **Workspace identity**. Review is
   against the saved base, including staged, unstaged and untracked changes. It is not
   an attribution claim. The directory-grouped explorer shows all returned findings,
   including withheld, binary, oversized and unavailable content. Filter by filename or
   change type; arrow keys/Home/End move and select within the file list.
2. Select a file to read its unified diff. Old/new line numbers, plus/minus markers and
   text-only keyword highlighting support common source extensions. Hunk controls jump
   between changes; line pages render at most 200 rows. Very long lines display a
   4,000-character prefix with a truncation label. Inspect the complete file locally.
3. Write a general comment, choose file scope, or select a numbered diff line. **Add
   comment** stages the text locally; **Save draft feedback** persists the draft to
   SQLite. Edit/remove comments before submission. Unsaved text blocks conflicting
   controls and triggers the browser's normal navigation warning. Reloading or switching tasks can still
   lose unpersisted text; save before leaving. **Discard unsaved edits and reload**
   explicitly discards local edits when resolving a draft conflict. Draft conflicts from another tab produce
   an error instead of silently overwriting newer feedback.
4. Select **Request Changes…**. Read the exact persisted feedback, reviewed task ID,
   revision, branch, worktree and saved session/thread in the modal. Cancel/Escape
   returns focus without submitting. **Confirm Request Changes** authorizes a write turn
   and its selected provider allowance. It creates one correction task in the existing
   assigned agent's FIFO. It never creates a replacement agent or SDK thread.
5. Follow continuation status, use **Stop continuation**, or select its task for the
   ordinary SSE event log. On completion/failure/stop the center refreshes Git review.
   Each finished write turn or canceled queued correction advances the review generation,
   even if it made no changes. A canceled correction retains only its pinned original
   session for a freshly confirmed retry.
   An interrupted run recovered after restart also advances its generation. Queued,
   explicitly confirmed submissions retain the existing restart authorization semantics.
6. Inspect **Iteration outcomes and verification**, then choose a revision in **Review
   history**. History pages hold 20 records; **Older history** and **Latest history**
   navigate without deleting records. Historical mode displays the saved bounded patch,
   comments, submission time, session/thread, continuation state/error and verification.
   It disables execution/Keep/Reject. It never reads historical file contents from the
   current worktree. These are review artifacts, not filesystem snapshots.
7. Return to **Current Git review**, review the correction, then Keep or Reject with the
   existing confirmation. Keep preserves files/branch for manual integration and closes
   continuation. Reject retains the branch and removes only the owned worktree after
   existing safety checks. Ignored files, nested repositories, advanced HEAD or uncertain
   ownership block automatic cleanup. All review records remain available after rejection.

Comments belong to one exact revision, with optional literal file path and old/new line
number validated against its persisted patch. Earlier anchors are always outdated outside
that revision. They are never relocated by line number or carried into the new draft.
Submitted comments are immutable. A repeated submission for the same workspace/revision
returns the original correction task; it cannot authorize another turn. A concurrent request
can report busy; retry returns the accepted record. Feedback edits use a draft version check.

The server checks fresh Git revision, pending decision, ownership, branch/base, configured
roots, queue conflicts, agent/provider and saved session. Revision and session identity are
checked again after asynchronous authentication, before execution under the existing leases.
A stale confirmation or unavailable/incompatible native session fails closed. Inspect the
error and saved native CLI transcript; restore the original context if possible. Refresh
and explicitly confirm a new revision to retry a failed iteration. The SDK owns transcript
loading; AI Office does not reconstruct missing transcripts, silently call startThread,
or promise recovery. A differing resumed thread ID is treated as a failure and stopped.

Verification remains **disabled by default**. With operator opt-in and separate full-host
confirmation, configured commands run through the existing verification supervisor. Results
are labeled with their input revision. Commands can themselves change files, so a later
revision labels the result as earlier; it is not proof of the new files. Scripts execute
with host permissions, not the agent sandbox. No arbitrary command can be supplied by HTTP.

Limits: 500 changed files, 256,000 characters per displayed patch, approximately 512,000
characters total diff content plus bounded filenames/metadata, 50 comments and 20,000
characters per feedback save. Git subprocess output/time and worktree ownership scans retain
v0.4 bounds. Unsupported/oversized content needs local inspection and stays visible as a
finding. Renames use the conservative base comparison (delete/add); raw Git status can show
rename information but no inferred rename pairing is offered. No side-by-side view, complete
language grammar highlighting, multi-user collaboration, automatic commit/push/merge, branch
deletion, filesystem snapshots or automatic integration is implemented. External editors
are outside app leases; revision checks are observations, not an atomic filesystem lock.

## SQLite migration

Schema 6 transactionally adds `review_records` keyed by workspace/revision with a unique
workspace-local revision number. Typed JSON stores bounded patches, comments, timestamps,
draft version, session/thread identity, submitted correction task and verification attribution.
A write generation is stored with workspace metadata; correction tasks retain an internal
revision/session binding. Existing tasks, sessions, bindings, queues and workspace ownership
are retained. No legacy task is automatically submitted and no legacy session gains write
privileges. Schema-5 application versions refuse schema 6. Back up the dedicated data
directory with the server stopped before upgrading; downgrade requires a matching backup,
not editing user_version. Runtime metadata remains private and Git-ignored. There is no
retention quota, encryption or general backup facility.
