# Session lifecycle

Tasks default to read-only. Start submits a task to its assigned persistent FIFO; each write submission requires explicit confirmation. Already submitted work can dispatch after restart. Running/stopping tasks recover as interrupted, never as completed or automatically retried.

After authorization and common/per-worktree lease acquisition, a write task records creation intent and atomically associates it with the task before directory/Git creation. It reserves a UUID path and branch at source HEAD; uncommitted source changes are not copied. Completion records canonical paths, base and filesystem ownership fingerprints. A crash or conflict can leave partial resources; intent remains available for inspection and nothing is automatically overwritten/deleted/adopted.

The Codex worker executes in the isolated directory with its restrictive profile. Filesystem identity is checked again after asynchronous authentication, immediately before execution. SSE persists progress/results with replay cursors. Stop enters `stopping`, requests SDK abort and waits for worker/process-group cleanup. Persistent cleanup uncertainty yields `interrupted` and retains leases; it never reports a confirmed stop.

Resume uses a new task with the same repository, execution mode, provider, agent and authentication context. It reuses only a pending, valid workspace with unchanged HEAD and the original native transcript. Read-only/write privilege changes, kept/rejected/ambiguous workspaces, missing fingerprints, replacement identities and advanced HEAD fail closed. Commits remain available for manual review/integration; the app does not reset them.

Review is independent of the agent transcript and refreshes from Git. Keep/Reject/Verify require the revision returned by that review; observed changes require another refresh/confirmation. State is reloaded under the common-directory/worktree leases before deciding. External editors are not excluded: do not edit during decision/cleanup. Sensitive, large and binary diffs may require local review.

Keep leaves files and the branch for manual integration. Reject records removal intent after ownership/HEAD/revision/ignored/nested-repository checks, then removes only the registered owned worktree. Branches remain. Interrupted/partial removal or a failed final database update produces a blocked recovery diagnostic, not automatic retry.

Host verification needs operator opt-in and a separate warning/acknowledgement. It records verification intent and uses an independent bounded supervisor. Normal shutdown aborts it and stops agents concurrently, waiting for cleanup before persistence closes. An abrupt backend death disconnects the supervisor, which also owns its own timeout. Interrupted operations remain visible across restart; deliberately detached descendants remain a documented limit.

See [workspace recovery](WORKSPACE_RECOVERY.md), [security model](SECURITY.md) and [setup/manual integration](V0_4_DEMO.md). Do not remove stale leases until processes and files have been inspected. A saved thread ID cannot reconstruct a missing native CLI transcript.
