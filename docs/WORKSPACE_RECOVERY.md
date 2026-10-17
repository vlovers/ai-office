# Workspace recovery

AI Office favors preserving files over unattended recovery. Do not remove SQLite or guess that a process is dead from an old PID alone. A worktree and branch may contain both AI changes and later human work.

## Diagnose without changing resources

Stop the affected task/application normally first. If it cannot stop, inspect the associated backend, Codex/verification worker and process group using OS process tools. Deliberately detached programs are not guaranteed to remain in that group. A retained lease is evidence that cleanup is unresolved, not permission to remove it.

Read the task's error and **Refresh Git review**. Interrupted operations show a recovery message with their saved branch/path; mutation controls are unavailable. Missing or replaced worktrees fail identity validation. Current operations may still be running; a recovery message alone does not prove termination.

Use read-only commands with your actual repository and saved paths:

```sh
git -C /path/to/source worktree list --porcelain
git -C /path/to/task-worktree status --short --untracked-files=all
git -C /path/to/task-worktree status --short --ignored
git -C /path/to/task-worktree log --oneline -5
git -C /path/to/task-worktree diff
```

Inspect the worktree locally and back up uncommitted, untracked and ignored files before any manual cleanup. Diffs may contain secrets; do not paste them into issue reports. Preserve nested repositories separately, including their Git metadata. A patch alone does not preserve ignored files, binary data or an entire nested repository.

## Recovery states

| Diagnostic                                     | Meaning and safe next step                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupted task                               | Worker/backend ended before normal completion. Confirm process cleanup, then use a new task with the same execution/authentication mode, agent and saved session only if the workspace is still valid and HEAD has not advanced.                                            |
| `creating`                                     | Intent was recorded before directory/Git creation. The path, branch or Git registration may exist partially or not at all. Inspect all three; AI Office does not adopt or retry them. Preserve any files and start a new task with a new identity.                          |
| `rejecting`                                    | Cleanup was interrupted or the final persistence update failed. Files may remain, be partially removed, or already be gone. The saved branch is retained by application cleanup. Inspect and preserve remaining files; do not repeat force-removal based on stale metadata. |
| `verifying`                                    | Host command execution was interrupted or its result could not be recorded. Verify worker/descendant termination before touching locks or files. Inspect results manually.                                                                                                  |
| Missing ownership fingerprint                  | Pre-hardening v0.4 workspace. The app cannot establish that the current resource is the original one. Inspect/integrate manually; no automatic fingerprint adoption. Read-only tasks/sessions remain compatible.                                                            |
| Missing/replaced directory or changed branch   | The saved ownership no longer matches. Never substitute a different worktree under the saved identity. Preserve both old backups and current files; integrate manually.                                                                                                     |
| Advanced HEAD                                  | Commits exist beyond the task base. Review/keep and integrate manually. Resume/reject will not reset or discard those commits.                                                                                                                                              |
| Ignored files, nested repository or scan limit | Automatic rejection is refused. Inspect and back up the data; perform your own deliberate cleanup only after identifying its ownership.                                                                                                                                     |
| Busy/stale lease                               | Another operation may still run. Do not infer safety from an absent backend or a reused PID.                                                                                                                                                                                |

## Locks and versions

The private application data directory contains `server.lock`. Cross-instance repository leases live below `/tmp/ai-office-worktrees-<uid>/`, keyed by SHA-256 of canonical common Git-directory and worktree Git-directory paths. An isolated operation may hold more than one lease. Private `owner.json` contains PID/resource/time for local diagnosis; do not post it publicly.

Only after confirming that **all** associated processes have stopped and preserving relevant files may the operator manually remove the specific stale lease directories. Never remove the shared root or unrelated leases. There is no automatic unlock endpoint, PID-based stealing or bulk cleanup. Do not run old and new application versions against the same resources. Schema v5 prevents older versions from opening the new metadata database, but separate data directories still require operational care.

Normal completed Keep/Reject decisions persist. An interrupted operation stays blocked for manual inspection; there is intentionally no automatic transition from an ambiguous filesystem state to “safe.” A successful manual integration does not require changing SQLite. Leave the historical record and create a fresh task. A missing native Codex transcript cannot be reconstructed from a saved thread ID.
