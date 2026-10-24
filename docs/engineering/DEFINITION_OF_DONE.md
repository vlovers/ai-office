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
- Check read-only defaults, write approval, sandbox, redaction, task lifecycle,
  queue idempotency, session snapshots, worktrees and migration integrity.
- Have an independent reviewer inspect the base-to-head diff and tests.
  Record the reviewed head SHA, reviewer identity and disposition of findings;
  reassess material changes after review. An AI assessment is not an authorized
  GitHub approval. Resolve blocking findings and rerun checks affected by fixes.
- Keep documentation, UI states and release notes aligned with actual behavior.
- Verify real Codex and native sandbox behavior in supported environments
  before claiming release acceptance.

See [review policy](REVIEW_POLICY.md) and
[release checklist](RELEASE_CHECKLIST.md).

For docs-only changes, runtime tests can be N/A when genuinely irrelevant;
verify links and command references instead.
