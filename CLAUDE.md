# Claude Code guidance — AI Office

Follow [AGENTS.md](AGENTS.md) as the canonical agent working agreement for this repository. Read the README, existing architecture/security documentation and linked issue before changing code.

Workflow: inspect → plan → implement a scoped change → run documented checks → report evidence → open a PR → obtain independent review. Do not assume tests passed unless they ran successfully.

Never override the security, data handling, deployment, release, or merge restrictions in AGENTS.md. If instructions conflict, stop and ask for clarification.

## Parallel work and verification

Use separate Git worktrees for concurrent agents and inspect the actual diff and test evidence. Do not treat an author summary as verification. Record the exact base and head revisions before integration.

## Runtime boundaries

Keep the local dashboard and task event endpoints loopback-only. The separate Delivery service requires its own HTTPS operator authorization and CSRF protection. An approval reservation is not permission to execute remote Git writes. Treat local release and Delivery activation as separate review decisions.
