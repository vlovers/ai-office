# Release checklist — ai-office

This is a process gate, not release authorization.

- [ ] Confirm current release baseline, exact candidate SHA, live open PR/issues and critical defects.
- [ ] Record what is implemented versus verified, accepted and shipped; ensure docs match release scope.
- [ ] Run applicable clean install, static checks, unit/integration/E2E and build against exact candidate revision.
- [ ] Verify security, sensitive settings, third-party rights and dependency changes; collect independent review evidence.
- [ ] Workflows: read-only default, explicit writes, sandbox, token/session redaction, task cancellation/resume, queue idempotency, snapshot version binding, worktree isolation, browser flows and migration integrity.
- [ ] Verify current tagged release separately from features merged into main; real Codex smoke and native sandbox environment must be evidenced, not inferred from mocked tests.
- [ ] Confirm environment-specific smoke checks and documented mitigation/rollback, with secrets excluded from logs.
- [ ] Obtain maintainer authorization before merge/deploy/package publishing.
- [ ] After release, verify real deployed origin or installed published artifact independently and record link/commit.

Never mark this checklist passed for commands not executed or evidence from a different SHA.
