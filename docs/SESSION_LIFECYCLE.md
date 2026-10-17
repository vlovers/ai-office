# Session lifecycle

Creation records a queued task with read-only (default) or write execution mode. Start submits it to the assigned agent FIFO. Each write submission requires `confirmedWrite: true`; an already authorized submission can recover from the persistent queue without another confirmation.

After acquiring the original repository lease, a write task validates authorization roots and creates `ai-office/<workspace UUID>` at the registered checkout's current HEAD in `<workspace root>/<workspace UUID>`. Uncommitted primary-checkout edits are not copied. A persisted workspace records the canonical Git directory, repository, branch and base commit. The agent executes only in that directory. Both modes retain the existing restricted environment, network denial, secret-file denies and approval-required blocking.

Running tasks stream persisted events with SSE cursors. Stop enters `stopping`, aborts the SDK and waits for worker/process-group cleanup before reporting `stopped`. Failed, interrupted and stopped sessions retain their workspace and Git review. Normal shutdown waits for active verification to finish (at most its execution bound) before closing persistence.

Restart marks unfinished tasks interrupted and retains workspace, session and review metadata. Existing locks still fail closed; inspect orphan processes before removing stale leases manually, as described in SECURITY.md. Resume by creating a new task with the same repository, execution mode, agent and authentication mode and selecting its saved session. Write resume revalidates and reuses the pending workspace. Missing native CLI transcripts fail visibly. Kept/rejected workspaces cannot resume.

Review is explicitly refreshed from Git after execution. Changes are measured against the saved base commit, including commits made manually. Created files are included without staging them. Large/binary/sensitive files may require local inspection. Verification results and keep/reject decisions persist separately from the agent transcript. Review and verification share the repository lease; sessions must stop before review.

Keep leaves all files and the branch available for manual integration and closes agent continuation. Reject requires confirmation and removes only the owned registered worktree, including uncommitted/untracked files. Branches always remain. Rejection refuses kept proposals, changed branch identities, advanced HEAD or locked worktrees. Cleanup errors leave review pending. No reset, branch deletion, merge, push or automatic commit occurs.
