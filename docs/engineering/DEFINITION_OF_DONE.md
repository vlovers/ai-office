# Definition of Done — AI Office

The states below are distinct:

- **Implemented:** The agreed change exists.
- **Verified:** Relevant checks and real-scenario evidence are available.
- **Accepted:** Blocking review findings are resolved and criteria approved.
- **Released:** Deployment or publication is independently verified.

## Criteria

- Document intended outcome, acceptance criteria and explicit non-goals.
- Preserve architecture and compatibility contracts; document data,
  permissions, migration and operational implications.
- Execute applicable static checks, tests and builds with exact outcomes.
  Report N/A with a reason, never in place of a failed check.
- For local dashboard/workflow changes, check read-only defaults, explicit
  write approval, sandbox, redaction, task lifecycle, queue idempotency,
  session snapshots, worktrees, migration integrity and Office V4 interaction
  where affected. Do not expose dashboard/Vite/SSE through a public ingress.
- For Delivery changes, separately check exact HTTPS Origin/Host, operator
  enrollment and live grants, CSRF, credential scope, Git/ref attestation,
  durable approval/intent atomicity, lease/recovery and revocation races.
  A reserved intent is not permission to commit, push or publish; remote write
  activation requires its own independent security and deployment gates.
- Have an independent reviewer inspect the base-to-head diff and tests.
  Record the reviewed head SHA, reviewer identity and disposition of findings;
  reassess material changes after review. An AI assessment is not an authorized
  GitHub approval. Resolve blocking findings and rerun checks affected by fixes.
- Keep documentation, UI states and release notes aligned with actual behavior.
  Distinguish a tagged release, code integrated into main, a PR-head check,
  and an unreleased Delivery authorization foundation.
- Record base/head SHAs and whether the PR is behind its target branch.
  If the base advances materially, reconcile and rerun affected checks and
  review before claiming integration readiness.
- Verify real Codex and native sandbox behavior in supported environments
  before claiming release acceptance.

See [review policy](REVIEW_POLICY.md) and
[release checklist](RELEASE_CHECKLIST.md).

For docs-only changes, runtime tests can be N/A when genuinely irrelevant;
verify links, command references and consistency with the current main
security/activation documentation instead. Missing native, real Codex, TLS or
real GitHub permission evidence must remain explicitly unverified.
