# Claude Code guidance

Follow [AGENTS.md](AGENTS.md) as the canonical shared engineering contract. Read the relevant existing architecture and security files before work.

Explore → Plan → Implement → Verify → Independent Review → Handoff. Keep parallel agent sessions in separate Git worktrees; evaluate actual diffs and test evidence rather than author summaries. Do not represent unexecuted commands as passed or bypass permissions, licensing, publishing or deployment gates.

Project boundaries: Local-first agent execution, task queue, write authorization, registered workspace roots, worktree ownership, SSE lifecycle, Review Center and durable recovery. Keep the dashboard, Vite and task/SSE endpoints loopback-only. The separately configured, unreleased Delivery API has its own HTTPS ingress and operator authorization; its approval/intent endpoints do not authorize remote Git writes. Do not expose the dashboard, elevate agent privileges from prompt/UI, auto-merge, or imply generic host safety. Treat local MVP release evidence and Delivery activation evidence as separate gates; verify the current base/head SHAs before integration.
