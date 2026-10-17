# Isolated coding demo and development setup

Use Node 24 and `npm ci`. Authenticate the existing Codex CLI using your normal CLI login. No API key is needed for local CLI mode. Work only with trusted repositories.

Create a separate canonical workspace directory (outside the primary checkout), then start the services:

```sh
mkdir -p /absolute/path/agent-worktrees
AI_OFFICE_AUTHORIZED_ROOT=/absolute/path/projects \
AI_OFFICE_WORKSPACE_ROOT=/absolute/path/agent-worktrees \
AI_OFFICE_VERIFICATION_COMMANDS='{"tests":["/absolute/path/to/node","--test"]}' \
npm run dev
# In another terminal:
npm run dev:web
```

Roots must be absolute. Resolve symlinked paths first (for example macOS `/tmp` is `/private/tmp`). Writes are disabled unless both roots are configured. Verification configuration is a JSON object mapping labels to argv arrays whose first entry is an absolute executable; it is server-owned, never a browser-supplied shell command. Dependencies are not installed automatically. Configure the correct executable for your project; use a trusted wrapper if setup is needed. Commands have a minimal environment, 60-second execution limit, maximum 120 seconds internally, and 128 KB output limit. Commands execute with host OS permissions, so inspect project scripts first. Never configure commands that modify a primary checkout or access secrets.

1. Register a committed repository inside the authorized root. Create a task with **Isolated coding · write enabled**.
2. Start it and confirm the write permission. Try: “Add a small utility and tests; do not commit.”
3. Follow progress; Stop retains partial changes after worker cleanup.
4. Click **Refresh Git review**. Check changed files, readable diffs, base commit, branch and worktree path. Tab focuses the scrollable diff; existing motion preferences still apply.
5. Run a configured verification command and inspect its persisted exit result/output. This runs local trusted code, with a separate confirmation.
6. Choose **Keep isolated changes** or **Reject and clean up…**. Rejection explicitly warns that uncommitted and untracked files will be discarded. The task branch is preserved.
7. For integration, inspect the isolated directory with your editor, stage and commit chosen files there yourself. From your destination checkout, inspect the saved branch with `git log`/`git diff`, then use your normal reviewed cherry-pick or merge workflow. AI Office performs none of these steps.

A dirty primary checkout stays dirty and unchanged. Isolated work starts from HEAD, not from those local modifications. Changes remain reviewable after failed execution, normal shutdown or restart. A crash during creation may leave an unrecorded worktree: inspect `git worktree list` and branches manually; the application does not remove unknown resources.

Validation: `npm run check`, `npm run format:check`, `npm run test:sandbox`, and `npm run test:browser`. `npm run test:real:write -- --run` is an optional paid-usage smoke test using existing CLI authentication only; never part of CI.

Example manual integration after **Keep**, with paths and commit IDs chosen by you:

```sh
# Inspect and commit selected files in the isolated worktree.
git -C /absolute/path/to/task-worktree status
git -C /absolute/path/to/task-worktree diff
git -C /absolute/path/to/task-worktree add -- path/to/reviewed-file
git -C /absolute/path/to/task-worktree commit -m "Implement reviewed change"
git -C /absolute/path/to/task-worktree log -1 --oneline
# In your destination checkout, inspect then integrate that commit yourself.
git show COMMIT_ID
git cherry-pick COMMIT_ID
```

Review your destination checkout and resolve any conflicts yourself. Rejection refuses nested Git repositories and worktrees exceeding the 50,000-entry ownership scan limit; these require manual cleanup.
