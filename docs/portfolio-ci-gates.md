# Portfolio CI and review gates — evidence ledger

Updated: 2026-10-26. Tracking: [#87](https://github.com/vlovers/ai-office/issues/87).

## Scope and truth labels

This is a **read-only planning inventory**, not proof that GitHub branch protections or rulesets are enabled. A workflow name in YAML is not necessarily the required status-check context: verify the exact check-run name on a successful PR and the configured branch rules before enforcing it. Never turn off an existing protection to fit this document.

| Repository | Integration branch | Observed CI / proposed required gate | Evidence and outstanding work |
| --- | --- | --- | --- |
| [AI Office](https://github.com/vlovers/ai-office) | `main` | AI Office validation: TypeScript, tests, smoke, build, formatting; Native Codex filesystem policy | [Governance PR #88](https://github.com/vlovers/ai-office/pull/88). [Run 40308667751](https://github.com/vlovers/ai-office/actions/runs/40308667751) pending at last check. Earlier run 40307882675 failed formatting; new result must be confirmed. |
| [Grid Atlas](https://github.com/vlovers/grid-atlas) | `main` | Foundation CI (`foundation`) and all other currently active PR checks after workflow inventory | `.github/workflows/ci.yml` observed on main; do not assume this is the only workflow. |
| [RuleWitness](https://github.com/vlovers/rulewitness) | `main` | RuleWitness CI (`check`) and permissions review | [PR #85](https://github.com/vlovers/rulewitness/pull/85); [CI run 40307895340](https://github.com/vlovers/rulewitness/actions/runs/40307895340) and [permissions run 40307895282](https://github.com/vlovers/rulewitness/actions/runs/40307895282) queued at last check. |
| [MutationBoundary](https://github.com/vlovers/mutation-boundary) | `main` | MutationBoundary checks (`test`), PostgreSQL-backed validation | [PR #71](https://github.com/vlovers/mutation-boundary/pull/71); [run 40307901206](https://github.com/vlovers/mutation-boundary/actions/runs/40307901206) succeeded. |
| [Estima](https://github.com/vlovers/estima) | `develop` | PostgreSQL integration and Bun migration validation across configured platforms | [PR #16](https://github.com/vlovers/estima/pull/16); [PostgreSQL run 40307907661](https://github.com/vlovers/estima/actions/runs/40307907661) succeeded; [Bun run 40307907999](https://github.com/vlovers/estima/actions/runs/40307907999) ARM passed, x64 pending at last check. |
| [Last Chapter](https://github.com/vlovers/last-chapter) | `main` currently bootstrap; game integration branch `feat/dialogue-engine-mara-frank-20261025` | Game CI `quality` and Browser QA, after branch integration strategy is approved | [Draft PR #14](https://github.com/vlovers/last-chapter/pull/14) targets game branch, changes only `CLAUDE.md`; [Browser QA run 40308469717](https://github.com/vlovers/last-chapter/actions/runs/40308469717) succeeded; [CI run 40308469474](https://github.com/vlovers/last-chapter/actions/runs/40308469474) queued at last check. Old governance PR #13 closed without merge. |

## Proposed protection policy (not yet enforced)

1. Require PRs into the actual integration branch, not direct pushes.
2. Require successful, non-skipped checks using **exact observed check-run contexts**. For matrix jobs, account for every platform that is meant to block merging. Avoid requiring a workflow that cannot trigger for the protected branch.
3. Require at least one **independent** approving review and dismissal of stale approvals on code changes. Automated self-review does not qualify.
4. Require conversations to be resolved, block force pushes and branch deletion, and restrict bypass permissions according to repository ownership.
5. Preserve current least-privilege workflow permissions; do not introduce privileged `pull_request_target` execution for untrusted PR code.
6. Keep release/publish/deploy credentials separate from ordinary PR CI. No release from an unreviewed PR.
7. Document exceptions explicitly, with owner and expiry, rather than silently weakening checks.

## Rollout checklist

- [ ] Inventory **all** workflows and active check contexts on each repository's integration branch.
- [ ] Inspect existing branch protection and rulesets with an authorized GitHub UI/API reader; record evidence and exact required contexts.
- [ ] Confirm reviewer availability and repository permissions before enabling required approvals.
- [ ] Resolve open CI failures and confirm checks complete on representative PRs.
- [ ] Resolve Last Chapter's integration branch policy without overwriting its richer game-specific instructions.
- [ ] Get explicit owner approval for changes to protection/rulesets.
- [ ] Enable gates in small batches, verify with a test PR, and record results in #87.


## Governance rollout inventory (refreshed 2026-10-27)

This inventory is based on repository file checks and the currently open PR search. It does not assert that any PR is approved, mergeable, or that branch protection is enabled. Do not create duplicate PRs or merge without current checks and independent review.

| Repository | Existing governance candidates | Next action |
| --- | --- | --- |
| AI Office | [#88 foundation governance](https://github.com/vlovers/ai-office/pull/88), [#89 evidence ledger](https://github.com/vlovers/ai-office/pull/89); follow-ups [#91 security intake](https://github.com/vlovers/ai-office/pull/91), [#80 action SHA pins](https://github.com/vlovers/ai-office/pull/80) | Review #88 and #89 first; independently review #91 and #80 against current main. Portfolio feature PRs are not governance prerequisites. |
| Grid Atlas | Governance baseline exists; [#271 issue intake](https://github.com/vlovers/grid-atlas/pull/271), [#272 immutable Actions pins](https://github.com/vlovers/grid-atlas/pull/272) | Preserve editorial/source/media safeguards; validate workflow pinning and issue templates separately. |
| RuleWitness | [#82 engineering governance](https://github.com/vlovers/rulewitness/pull/82), [#85 agent agreement](https://github.com/vlovers/rulewitness/pull/85), [#83 issue/security intake](https://github.com/vlovers/rulewitness/pull/83) | Reconcile overlapping docs and retain package-safety rules. |
| MutationBoundary | [#68 engineering governance](https://github.com/vlovers/mutation-boundary/pull/68), [#71 agent agreement](https://github.com/vlovers/mutation-boundary/pull/71), [#69 issue intake](https://github.com/vlovers/mutation-boundary/pull/69) | Reconcile overlap and retain disposable PostgreSQL-only tests and redacted diagnostics. |
| Estima | [#13 engineering governance](https://github.com/vlovers/estima/pull/13), [#16 agent agreement](https://github.com/vlovers/estima/pull/16), [#14 contributing/security baseline](https://github.com/vlovers/estima/pull/14), [#15 Actions SHA pins](https://github.com/vlovers/estima/pull/15) | Target develop, not main; retain tenant isolation and migration gates. |
| Last Chapter | [#5 engineering foundation](https://github.com/vlovers/last-chapter/pull/5), [#14 Claude guidance](https://github.com/vlovers/last-chapter/pull/14) | Resolve integration strategy carefully: active game branch has richer narrative/architecture rules than bootstrap main. |

### Rollout exit criteria

1. Select canonical governance PR(s) per repository; do not close duplicates until confirming no unique changes would be lost.
2. Check changed files against the current target branch and current CI result; old branch snapshots and CI runs are not evidence for the latest head.
3. Verify local links and exact package scripts; report unrun tests honestly.
4. Obtain independent review on the exact head SHA and resolve blocking findings.
5. Inspect actual rulesets/branch protection through an authorized reader and capture exact check contexts. Status remains unknown until verified; documentation is not enforcement.
6. Obtain explicit owner authorization before changing branch protection, merging, publishing, or deploying.
7. After authorized integration, re-fetch files from the target branch and update this ledger with evidence.


## Review evidence snapshot (2026-10-27)

Read-only inspection of review submissions for the principal governance PRs found no submitted review records for AI Office #88/#89, RuleWitness #85, MutationBoundary #71, Estima #16, or Last Chapter #5/#14. RuleWitness #82, MutationBoundary #68 and Estima #13 each have a COMMENTED review authored by `vlovers`; this is useful technical commentary but is not independent approval. This is a snapshot, not proof that no off-platform review occurred.

| Project | Canonical candidate to review first | Overlap / dependency to reconcile |
| --- | --- | --- |
| AI Office | #88 | #89 is a supporting evidence ledger; #91 and #80 are separate security/workflow changes. #90/#92 are product features, not governance prerequisites. |
| Grid Atlas | Existing default-branch governance | #271 and #272 should be reviewed separately for issue intake and immutable Actions pins. |
| RuleWitness | #82 | Reconcile with #85 agent agreement and #83 issue/security intake; preserve unique safeguards before deciding whether to stack or supersede. |
| MutationBoundary | #68 | Reconcile with #71 agent agreement and #69 issue intake; preserve database isolation and diagnostics requirements. |
| Estima | #13 | Reconcile with #16 agent agreement, #14 contributing/security baseline and #15 action pins; target branch is `develop`. |
| Last Chapter | #5 only after target-branch strategy is confirmed | #14 targets the active game branch and adds Claude guidance; preserve the richer game-specific contract and do not blindly replay onto bootstrap `main`. |

### Required next actions

- Obtain independent review from a reviewer distinct from the author on the exact current head SHA; do not count author-authored COMMENTED reviews as independent approval.
- Re-check CI for each current head after review comments are addressed.
- Resolve overlap by comparing diffs and target branches before closing or superseding any PR; do not merge automatically.
- Branch-protection/ruleset status remains **unverified** in this workflow; no configuration changes have been made.


## PR overlap analysis (2026-10-27)

Diff inspection confirms the following governance PRs overlap on the same canonical files. They must not be merged together without first selecting/rebasing a canonical version:

- **RuleWitness:** #82 and #85 both add `.github/PULL_REQUEST_TEMPLATE.md`, `AGENTS.md`, `CLAUDE.md`, `docs/engineering/RELEASE_CHECKLIST.md`, and `docs/engineering/REVIEW_POLICY.md`. #82 additionally adds `docs/engineering/DEFINITION_OF_DONE.md`; #83 is a separate issue/security-intake batch. Recommended approach: choose one foundation PR as canonical, then cherry-pick only unique project safeguards from the other after diff review; handle #83 separately.
- **MutationBoundary:** #68 and #71 overlap on PR template, `AGENTS.md`, `CLAUDE.md`, review policy and release checklist. #68 also changes `CONTRIBUTING.md`, `README.md`, `docs/RELEASING.md`, `docs/SAFETY.md`, and adds Definition of Done. #69 is a separate issue-intake batch. Preserve the broader safety/release documentation in #68; port any unique safeguards from #71 into it rather than merging both file sets.
- **Estima:** #13 and #16 overlap on PR template, `AGENTS.md`, `CLAUDE.md`, review policy and release checklist. #13 additionally adds Definition of Done; #14 adds contributor/security intake and #15 pins third-party Actions. Target is `develop`. Preserve tenant isolation, auth and migration gates.
- **Last Chapter:** #5 is the engineering foundation, while #14 adds only `CLAUDE.md` to the active game branch. Do not treat these as interchangeable: confirm base branch strategy and preserve narrative-specific `AGENTS.md` and PR template.

### Safe consolidation recommendation

1. Treat #82, #68, and #13 as the richer foundation candidates for RuleWitness, MutationBoundary, and Estima respectively, subject to current-base and CI checks.
2. Do not close #85, #71, or #16 until unique changes are diffed and any missing safeguards are copied into the chosen candidate or verified already present.
3. Keep issue/security intake PRs (#83, #69, #14 Estima) separate from engineering contract consolidation so their templates and security routing can be reviewed independently.
4. Do not merge based on this diff inventory alone. Verify current head/base, current CI, independent approval, and maintainer authorization.


## Shared-file overlap verified (2026-10-27)

Fetched and compared the current PR diff payloads for RuleWitness #82/#85, MutationBoundary #68/#71, and Estima #13/#16. In each pair, the smaller agent-agreement PR changes only files already present in the broader foundation PR; there are **no files unique to the smaller PR**. The shared files differ in content, so this does not prove all safeguards are already present in the foundation candidate.

| Pair | Shared paths | Unique paths in smaller PR | Recommendation |
| --- | ---: | ---: | --- |
| RuleWitness #82 / #85 | 5 | 0 | Keep #82 as candidate; compare semantic safeguards in AGENTS, PR template, review and release docs before retiring #85. |
| MutationBoundary #68 / #71 | 5 | 0 | Keep #68 as candidate; verify #71's project-specific database/diagnostics rules are retained in #68. |
| Estima #13 / #16 | 5 | 0 | Keep #13 as candidate; verify #16's tenant/auth/migration checks are retained in #13. |

These are candidate selections based on changed-file scope only, not merge-readiness decisions. Before closing any smaller PR, compare the actual added requirements, confirm the foundation candidate is current against its base, check CI, and obtain independent approval. No PR was closed, edited, or merged in this step.


## Semantic comparison of overlapping governance files (2026-10-27)

Content comparison of the shared files found meaningful differences, not just duplicate paths. The broader foundation candidates contain more domain-specific detail; the smaller agent-agreement PRs are more concise and add a few explicit safeguards. Consolidation must preserve the stronger combined contract rather than simply close the smaller PR.

### RuleWitness #82 vs #85
- Keep from #82: explicit limited-scope product contract; `complete: false`, uncertainty/fail-closed behavior and exit-code semantics; never execute analyzed settings/hooks/commands; reviewer focus on false negatives, schema drift, unsafe Git/CI and consumer/package evidence; release-readiness and npm provenance checks.
- Ensure explicit from #85 remains in canonical docs: Node 24 command list, `test/independent-witness.test.ts` oracle regression for matcher changes, no automatic npm publication, and clear distinction between permitted repository packaging checks and forbidden analyzed third-party lifecycle execution.
- #82 is the stronger foundation candidate, but its template should include the explicit project checks from #85 before #85 is considered redundant.

### MutationBoundary #68 vs #71
- Keep from #68: net-state-only product limitation; explicit disposable DB prohibition; secrets/row/key redaction; fail-closed behavior; release verification of packed tarball and real consumer; specific driver/session/concurrency/cleanup review priorities.
- Ensure explicit from #71 remains: dedicated `mutation_boundary_test`, `mutation_boundary_ci` role and `MUTATION_BOUNDARY_TEST_DATABASE_URL`; every bug fix needs a regression test; broad API/new adapter scope must be discussed before implementation.
- #68 is the stronger foundation candidate, but its canonical PR template and AGENTS contract must include the dedicated database-role and regression-test requirements.

### Estima #13 vs #16
- Keep from #13: actual Bun/Nx command discovery; tenant cross-user read/write checks; atomic clarification writes and concurrent retry; refresh JWT lifecycle; migration-chain and rollback checks; E2E and release evidence tied to exact candidate SHA.
- Ensure explicit from #16 remains: negative cross-tenant/auth tests, atomic update/delete behavior, disposable PostgreSQL for migration checks, and no production credentials.
- #13 is the stronger foundation candidate, but these concise checks should be explicitly visible in its PR template and agent contract.

### Consolidation status

These findings are recommendations for the PR authors/canonical branches; no pull request has been edited or closed by this audit. Before declaring any smaller PR redundant, confirm the missing safeguards have been added to the selected foundation candidate, check the exact current base/head and CI, and obtain independent review.


## Candidate CI evidence rechecked (2026-10-27)

Requeried PR-triggered workflow runs for the exact head SHAs recorded in the three foundation PR descriptions. These results confirm historical evidence on those SHAs only; they do **not** establish that each PR still has the same head SHA or that CI is current after subsequent changes.

| PR | Recorded head SHA | Workflow evidence | Interpretation |
| --- | --- | --- | --- |
| [RuleWitness #82](https://github.com/vlovers/rulewitness/pull/82) | `7ea6357de953a8cb9e37140dc2b67765f7941b5b` | RuleWitness CI: success; permissions review: success | Historical exact-SHA checks confirmed; recheck current PR head before merge. |
| [MutationBoundary #68](https://github.com/vlovers/mutation-boundary/pull/68) | `d901cc88697a0e3008f866d32b6385f17342d52d` | MutationBoundary checks: success | Historical exact-SHA check confirmed; recheck current PR head before merge. |
| [Estima #13](https://github.com/vlovers/estima/pull/13) | `804873ea0b0c6311cce9dd7e883df1224ac93bfa` | PostgreSQL integration validation: success; Bun migration validation: success | Historical exact-SHA checks confirmed; recheck current PR head before merge. |

Review submissions previously inspected showed no non-author APPROVED review on these candidates. Workflow success does not replace independent approval, and these results do not prove required branch protection is enabled. Next gate: obtain current PR head/base SHA and current checks, then independent review on that exact diff.

