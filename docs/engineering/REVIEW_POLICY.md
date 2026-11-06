# Independent code review — ai-office

Reviewer must independently inspect task acceptance criteria, original diff, relevant code, tests, configuration, and security/product policies. A different agent/model can provide an independent technical assessment, but that assessment is not deterministic testing and does not constitute a GitHub approval by an authorized reviewer. Record the reviewer identity, base/head SHA and scope of evidence; repeat or explicitly reconcile the review after material changes to the head commit.

Priorities: (1) user-visible behavior and data correctness; (2) security/privacy/permissions; (3) regression and migration/API compatibility; (4) ineffective tests, missing boundary cases or mock-only evidence; (5) scope, duplication and maintenance.

Project-specific focus for the **local dashboard**: read-only default, explicit writes, sandbox, token/session redaction, task cancellation/resume, queue idempotency, snapshot version binding, worktree isolation, browser flows, Office V4 accessibility where affected, and migration integrity. The dashboard, Vite and task/SSE routes remain loopback-only.

The **separate, unreleased Delivery ingress** additionally requires inspection of exact HTTPS Origin/Host, operator enrollment and live workspace grants, session/CSRF and revocation races, credential scope, approval expiry, local/remote Git ref attestation, commit identity, journal and receipt integrity, lease ownership, retry idempotency, startup reconciliation, and partial-failure recovery. Test duplicate requests, stale approvals, changed refs, ambiguous remote outcomes, and interrupted execution. An approval or transfer intent is only a reservation: no remote Git writer is authorized by it. A successful mocked API response is not evidence of a safe real remote write. Check the dedicated production security and activation checklists before asserting readiness.

Findings must include severity, file/line or relevant change, concrete failure scenario or uncertainty, and actionable fix/test. High-risk correctness or security findings block acceptance. Medium findings need written disposition and follow-up. Do not claim that a passing CI, visual screenshot or reviewer opinion proves the whole product is ready.

Before approval, compare the exact head SHA against the current target branch. A passing CI run on an older base does not establish integration safety after material base changes. Record the required revalidation and keep blocked gates open.

Only approved maintainers merge and authorize releases. Reviewers do not silently rewrite the author branch.
