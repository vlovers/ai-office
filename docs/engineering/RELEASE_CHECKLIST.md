# Release checklist — ai-office

This is a process gate, not release authorization.

- [ ] Confirm current release baseline, exact candidate SHA, live open PR/issues and critical defects.
- [ ] Record what is implemented versus verified, accepted and shipped; ensure docs match release scope.
- [ ] Run applicable clean install, static checks, unit/integration/E2E and build against exact candidate revision.
- [ ] Verify security, sensitive settings, third-party rights and dependency changes; collect independent review evidence tied to the exact head SHA. Distinguish technical AI review from an authorized GitHub approval; revalidate reviews after material changes.
- [ ] Local dashboard/workflows: read-only default, explicit writes, sandbox, token/session redaction, task cancellation/resume, queue idempotency, snapshot version binding, worktree isolation, browser flows, Office V4 keyboard/reduced-motion behavior where affected, and migration integrity.
- [ ] Keep the local dashboard, Vite and task/SSE routes loopback-only. Do not confuse their authorization model with the dedicated Delivery ingress.
- [ ] If Delivery is in scope, assess its **separate unreleased activation gate**: target HTTPS Origin/Host and CSRF in a real browser, live operator grants and revocation, scoped server-only credentials, Git/ref attestation, approval/intent atomicity, shared leases and startup recovery. Verify journal/receipt consistency, retry idempotency and recovery after ambiguous remote outcomes. A reserved approval/intent is not authority to execute Git writes; do not enable commit, push or Draft PR publication routes without separate independent security approval and target-platform evidence.
- [ ] Record which Delivery checks are fixture-only, which use actual HTTP/Git/SQLite processes, and which require real TLS/GitHub credentials. Missing deployment evidence is a blocker, not a pass.
- [ ] Verify current tagged release separately from features merged into main; real Codex smoke and native sandbox environment must be evidenced, not inferred from mocked tests.
- [ ] Confirm environment-specific smoke checks and documented mitigation/rollback, with secrets excluded from logs.
- [ ] Before integrating this documentation-only foundation PR, compare its six added paths against the current `main` tree. If all six remain absent, preserve the additive diff and review the current `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/MVP_STABILIZATION_CHECKLIST.md`, and Delivery security/activation documents for contract drift. Do not mistake commit-graph divergence alone for a textual conflict; verify actual Git mergeability and CI on the eventual candidate.
- [ ] Sequence the dependent security/issue-intake PR #48 and workflow SHA-pinning PR #49 only after the foundation PR is independently accepted. Recheck overlapping paths, new workflows on `main`, current-head CI and reviewer approval for each dependent PR; never reuse predecessor CI as evidence.
- [ ] Check the target branch has not materially advanced beyond the reviewed base SHA. If it has, reconcile and rerun affected CI/review on the new integration candidate.
- [ ] Obtain maintainer authorization and any required independent GitHub approval before merge/deploy/package publishing.
- [ ] After release, verify real deployed origin or installed published artifact independently and record link/commit.

Never mark this checklist passed for commands not executed or evidence from a different SHA.
