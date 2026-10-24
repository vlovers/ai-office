# Claude Code guidance

Follow [AGENTS.md](AGENTS.md) as the canonical shared engineering contract. Read the relevant existing architecture and security files before work.

Explore → Plan → Implement → Verify → Independent Review → Handoff. Keep parallel agent sessions in separate Git worktrees; evaluate actual diffs and test evidence rather than author summaries. Do not represent unexecuted commands as passed or bypass permissions, licensing, publishing or deployment gates.

Project boundaries: Local-first agent execution, task queue, write authorization, registered workspace roots, worktree ownership, SSE lifecycle, Review Center and durable recovery. Never expose the local server publicly, elevate agent privileges from prompt/UI, auto-merge, or imply generic host safety.
