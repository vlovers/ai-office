# Independent code review — ai-office

Reviewer must independently inspect task acceptance criteria, original diff, relevant code, tests, configuration, and security/product policies. A different agent/model can provide an independent technical assessment, but that assessment is not deterministic testing and does not constitute a GitHub approval by an authorized reviewer. Record the reviewer identity, base/head SHA and scope of evidence; repeat or explicitly reconcile the review after material changes to the head commit.

Priorities: (1) user-visible behavior and data correctness; (2) security/privacy/permissions; (3) regression and migration/API compatibility; (4) ineffective tests, missing boundary cases or mock-only evidence; (5) scope, duplication and maintenance.

Project-specific focus: Workflows: read-only default, explicit writes, sandbox, token/session redaction, task cancellation/resume, queue idempotency, snapshot version binding, worktree isolation, browser flows and migration integrity.

Delivery publication and Git-transfer changes additionally require inspection of approval scope/expiry, local and remote Git ref attestation, commit identity, journal and receipt integrity, lease ownership, retry idempotency, startup reconciliation, and partial-failure recovery. Test duplicate requests, stale approvals, changed refs, ambiguous remote outcomes, and interrupted execution. A successful mocked API response is not evidence of a safe real remote write.

Findings must include severity, file/line or relevant change, concrete failure scenario or uncertainty, and actionable fix/test. High-risk correctness or security findings block acceptance. Medium findings need written disposition and follow-up. Do not claim that a passing CI, visual screenshot or reviewer opinion proves the whole product is ready.

Only approved maintainers merge and authorize releases. Reviewers do not silently rewrite the author branch.
