# Definition of Done — ai-office

Four distinct states: **Implemented** (the agreed change exists), **Verified** (relevant automated and real-scenario checks are evidenced), **Accepted** (independent blocking findings addressed and requirements signed off), and **Released** (deployment/publication separately verified). Do not collapse them into a generic “done”.

## Criteria
- Outcome and explicit acceptance criteria documented; no unrelated modifications or silently reduced scope.
- Preserve architecture and compatibility contracts; report migration, API, security, localization and operational impacts.
- Applicable lint/typecheck/build/unit/integration/E2E executed with exact outcome; use N/A only with a reason, not as a substitute for a failed check.
- Workflows: read-only default, explicit writes, sandbox, token/session redaction, task cancellation/resume, queue idempotency, snapshot version binding, worktree isolation, browser flows and migration integrity.
- Independent reviewer checks the base-to-head diff against requirements, not just the author's summary; blocking findings fixed and retested.
- Docs, examples, UI states and release limitations match actual behavior.
- Verify current tagged release separately from features merged into main; real Codex smoke and native sandbox environment must be evidenced, not inferred from mocked tests.

See [review policy](REVIEW_POLICY.md) and [release checklist](RELEASE_CHECKLIST.md). Runtime tests are not mandatory for docs-only changes when genuinely irrelevant, but links and command references still require inspection.
