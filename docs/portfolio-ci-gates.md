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


## Independent content review notes (2026-10-27)

Read-only reviewer pass over the available PR diff payloads for RuleWitness #82, MutationBoundary #68 and Estima #13 found the following concrete items to validate before acceptance. This is an assistant technical assessment, not an authorized GitHub review submission.

- **RuleWitness #82:** The PR template requires package smoke and `npm pack --dry-run`; the AGENTS contract correctly distinguishes the repository's own documented packaging/build checks from executing analyzed third-party lifecycle scripts. During review, verify the implemented package test actually disables scripts for installed analyzed packages and that unknown/fail-closed and exit-code 3 cases are asserted by independent tests, not only described in docs.
- **MutationBoundary #68:** The docs strongly require disposable PostgreSQL, but its test instructions include a named database and role. Review must verify the executable test guard independently establishes an isolated/disposable target rather than treating database name or a confirmation flag as proof; also check redaction tests cover connection strings, row values and keys.
- **Estima #13:** The docs correctly point to `develop` and emphasize tenant boundaries and atomic writes. Review must verify that the referenced scripts exist on the current target branch and that the cross-tenant negative tests and migration rollback claims are backed by actual integration tests rather than the documentation checklist alone.

### Acceptance status

These are review prompts, not confirmed defects. The available tools expose diff content and historical CI runs but do not provide a reliable current PR head/base SHA snapshot here. Therefore current-head CI, current branch protection, and independent reviewer approval remain **unverified**. Do not mark these candidates accepted or merge-ready until a reviewer checks the current exact diff and GitHub shows the required approval/checks.


## Review status refresh (2026-10-27)

Review submissions were re-queried for the open governance PRs. This snapshot confirms no submitted review records for AI Office #88/#89, RuleWitness #85, MutationBoundary #71, Estima #16, or Last Chapter #5/#14. RuleWitness #82, MutationBoundary #68, and Estima #13 each have only a `COMMENTED` submission by the repository owner `vlovers`; none is an independent `APPROVED` review. Grid Atlas review state was not rechecked in this pass.

| Repository | Candidate | Submitted independent approval observed | Next action |
| --- | --- | --- | --- |
| AI Office | [#88](https://github.com/vlovers/ai-office/pull/88) | No | Request independent review of exact current diff. Check #89 separately as evidence-ledger support. |
| RuleWitness | [#82](https://github.com/vlovers/rulewitness/pull/82) | No | Reconcile safeguards from #85, then request independent review. |
| MutationBoundary | [#68](https://github.com/vlovers/mutation-boundary/pull/68) | No | Verify DB safety gates and unique safeguards from #71, then request independent review. |
| Estima | [#13](https://github.com/vlovers/estima/pull/13) | No | Verify tenant/migration gates and unique safeguards from #16; target `develop`; request independent review. |
| Last Chapter | [#5](https://github.com/vlovers/last-chapter/pull/5) | No | Confirm intended base branch and preserve narrative-specific rules; #14 is a separate Claude guidance change. |

Do not mark any candidate accepted/merge-ready on this evidence. Review state, current head SHA and CI must be refreshed immediately before merge; obtain required maintainer authorization. No PR was merged or closed in this pass.


## Grid Atlas and remaining AI Office review snapshot (2026-10-27)

Rechecked review submissions for Grid Atlas #271/#272 and AI Office #88/#89. All four returned zero submitted review records. Last Chapter #5/#14 also returned zero in the previous pass. This is evidence only about submitted GitHub reviews, not private/off-platform review.

| PR | Review submission evidence | Next gate |
|---|---|---|
| [Grid Atlas #271](https://github.com/vlovers/grid-atlas/pull/271) | No submitted reviews observed | Independent review of issue intake and acceptance criteria; preserve editorial/source/media checks. |
| [Grid Atlas #272](https://github.com/vlovers/grid-atlas/pull/272) | No submitted reviews observed | Independently verify every workflow Action pin is a full immutable commit SHA and verify any version comments/references. |
| [AI Office #88](https://github.com/vlovers/ai-office/pull/88) | No submitted reviews observed | Review the foundation against current main and validate security boundaries. |
| [AI Office #89](https://github.com/vlovers/ai-office/pull/89) | No submitted reviews observed | Review evidence ledger independently; ensure it does not imply enforcement that has not been verified. |

### Practical review handoff

Before assigning reviewers, choose a reviewer account/team with repository access and no authorship conflict. This workflow has not requested a reviewer because no suitable reviewer identity was established. Do not use the repository owner as a substitute for independent review. Branch protection/ruleset enforcement remains unverified because the available connector did not expose an authoritative read action in this pass.


## Grid Atlas workflow-pin and issue-intake review (2026-10-27)

### PR #272 — immutable Actions pins

Diff inspection shows the workflow updates replace common tags with full commit references for `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact`, and set `persist-credentials: false` for checkout in many workflows. However, the diff also contains multiple occurrences of `actions/checkout@v4` and `actions/upload-artifact@v4` in test fixtures, scripts, and examples. These may be intentionally unpinned negative fixtures used to test the audit; the PR must demonstrate that production workflow files are clean while negative fixtures remain intentional.

Review checklist before approval:
- [ ] Run `scripts/check-workflow-action-pins.mjs` against the candidate and verify it scans all production `.github/workflows/*.yml` files, not just a fixed subset.
- [ ] Confirm every actual workflow `uses: owner/action@ref` uses a full 40-character commit SHA; distinguish local actions and Docker image digest pins correctly.
- [ ] Confirm the SHA comments map to the intended upstream action versions and are not the only evidence of identity.
- [ ] Verify `persist-credentials: false` wherever checkout credentials are not needed; check workflows that intentionally require authenticated Git operations separately.
- [ ] Run the action-pin tests, including negative fixtures for tags and malformed refs; inspect permissions and workflow triggers for privileged `pull_request_target` or write-token paths.
- [ ] Confirm current CI on the current PR head and independent review.

### PR #271 — issue intake

The diff adds `.github/ISSUE_TEMPLATE/bug_report.md` and `engineering_task.md`. Review that bug reports collect reproducible evidence without asking users to publish secrets or personal data; engineering tasks request scope, acceptance criteria, tests and risk; neither template promises automated triage or merge enforcement unless a workflow/ruleset actually implements it.

### Current status

This is a static diff review only. No tests were run by this review pass, and current head SHA, current CI and independent approval were not verified. Do not treat either PR as accepted or merge-ready based on this inspection.


## Grid Atlas #272 — deeper scanner/test review (2026-10-27)

Reviewed the full added `scripts/check-workflow-action-pins.mjs` and `tests/workflow-action-pins.test.mjs` from PR #272 diff. This was static inspection only; the tests were not executed in this workflow.

### Positive controls present in the diff
- Scans YAML files directly under `.github/workflows` and fails if no workflows are found.
- Rejects mutable tags, short SHA, empty/dynamic refs, ambiguous YAML forms, malformed local paths and Docker tags; supports full action SHA and Docker digest pins.
- Requires checkout `persist-credentials: false` exactly once inside the same step's `with` mapping.
- Adds negative tests for mutable tags, short SHA, dynamic refs, traversal, duplicate mappings, malformed YAML and checkout credentials placed in later/unrelated steps.

### Remaining review items (not confirmed defects)
- The scanner is intentionally a line-based constrained YAML parser, not a full YAML parser. Confirm its rejection patterns cover every YAML representation accepted by GitHub Actions, or document and enforce a narrow supported syntax. Add adversarial fixtures for folded/block scalar values and any valid YAML syntax the current regexes do not reject.
- The repository-wide test only asserts at least 10 workflows are scanned. Consider asserting the expected workflow inventory/count or a fixture that proves adding a nested/otherwise overlooked workflow cannot silently bypass audit scope.
- Verify all actual workflow references in the full candidate are pinned; the diff also includes mutable references in tests/scripts, which should remain explicitly test fixtures rather than workflow invocations.
- Validate the pinned SHAs against the upstream repositories/releases and inspect `permissions`, triggers, and any privileged write-token workflows separately; SHA pinning alone is not a complete workflow security review.

### Gate status

Diff review identified strong coverage but cannot establish runtime test success. No tests were executed here, current PR head/base SHA and CI freshness remain unverified, and no independent review approval was observed in the prior review-submission query. PR #272 is therefore not marked accepted or merge-ready.


## Grid Atlas #272 current integration blocker confirmed (2026-10-27)

Fetched the live PR metadata and the current default-branch `.github/workflows/commons-original-review.yml`.

- PR #272 current reported head: `5dbec0773952fc417c8cebe40f67e226e2610b9f`; base `main` at `7bea3bb9bab06f93cc6547e3fe2e5e89294711b4`; GitHub reports `mergeable=false`.
- The current default-branch workflow `.github/workflows/commons-original-review.yml` is absent from the PR branch diff and still contains mutable `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4` references.
- Therefore full repository-wide pin coverage cannot be claimed for PR #272 as it stands. The PR body itself identifies this workflow as a post-divergence blocker.
- Safe next action is to reconcile the PR branch with current `main`, resolve any add/add conflict by retaining the complete research-only workflow behavior, pin the three actions to verified full SHAs, and then rerun `npm run check`, `npm test`, relevant workflow CI, and the existing failing UI/accessibility workflow separately. Do not relax the 200%-text overflow assertion or mix unrelated UI changes into the security PR.
- Current CI is not confirmed green and independent approval is outstanding. Do not merge until the new workflow is covered, the branch is current/mergeable, current-head checks pass, and independent review is recorded.

This is a live metadata and default-branch file check, not a branch modification. No PR files or workflows were changed in this step.


## Follow-up implementation for current-main Actions gap (2026-10-27)

Created a separate draft PR against current `main` rather than modifying the stale #272 branch directly:
- [Grid Atlas #319 — pin Actions in Commons originals workflow](https://github.com/vlovers/grid-atlas/pull/319)
- Branch: `security/pin-commons-review-actions-20261027`
- Head SHA: `320c882d5b587adb73435ab1d854eb20f79467c2`
- Change: pin checkout/setup-node/upload-artifact to full SHA and set checkout `persist-credentials: false`; preserve read-only `contents` permission, research-only artifact behavior and fail-closed check.

This is a focused integration follow-up created from current `main`, not a merge or replacement of #272. The PR is draft; tests and CI have not been run on this new head. Keep it unapproved until CI and independent review pass. The older #272 remains blocked until safely reconciled with the newer main history and all workflows are covered.


## 2026-10-27 01:00 — Grid Atlas #319 CI failure triage and fix

- Checked [draft PR #319](https://github.com/vlovers/grid-atlas/pull/319), initial head `320c882d5b587adb73435ab1d854eb20f79467c2`, mergeable=true, no submitted GitHub reviews.
- [Foundation CI run 40414299431](https://github.com/vlovers/grid-atlas/actions/runs/40414299431) **failed**: 349/350 Node tests passed. `tests/commons-original-review-workflow.test.mjs` asserted the old mutable `actions/upload-artifact@v4` string, which correctly disappeared after the pin. The workflow itself passed foundation validation; failure was the outdated test expectation.
- Fixed the test in PR #319 branch: assert immutable 40-hex action references for checkout/setup-node/upload-artifact, reject `actions/*@vN`, and require checkout `persist-credentials: false`. Fix commit: [`6fd8ef4d6ac64acb2d3ad9979abfb05a09583f2e`](https://github.com/vlovers/grid-atlas/commit/6fd8ef4d6ac64acb2d3ad9979abfb05a09583f2e).
- Verified all three pinned SHAs resolve to commits in their official `actions/*` repositories. SHA existence does not by itself prove the version comment matches a release tag; tag-to-commit verification is a separate check.
- [Foundation CI run 40417012847](https://github.com/vlovers/grid-atlas/actions/runs/40417012847) on the fixed head was **in progress** at this checkpoint. Do not claim green until it completes. Independent review remains outstanding; PR stays draft, no merge.

Next: inspect the completed exact-head CI; if green, check version tag-to-commit mapping and remaining security review. Then proceed to #272 branch reconciliation.


**CI follow-up (same checkpoint):** [Foundation CI run 40417012847](https://github.com/vlovers/grid-atlas/actions/runs/40417012847) completed with **success** on exact PR #319 head `6fd8ef4d6ac64acb2d3ad9979abfb05a09583f2e`. This confirms Foundation CI only, not the Commons originals research workflow or the full repository CI matrix. Independent approval and exact release-tag mapping remain unverified; keep PR draft.


## 2026-10-27 02:00 — Grid Atlas #272 divergence and new-workflow pin follow-up

- Refreshed [PR #319](https://github.com/vlovers/grid-atlas/pull/319): exact head `6fd8ef4d6ac64acb2d3ad9979abfb05a09583f2e`, `mergeable=true`, draft, no submitted reviews. The connector returned one pull-request-triggered **Foundation CI success** for that head; this does not establish all-workflow CI success. `main` had advanced two commits beyond this head when compared.
- Refreshed [PR #272](https://github.com/vlovers/grid-atlas/pull/272): exact head `5dbec0773952fc417c8cebe40f67e226e2610b9f`, 31 commits ahead / 18 behind current `main`, `mergeable=false`, no submitted reviews and no PR-triggered runs returned for that exact head. Empty runs/status results are not evidence of green CI.
- Inspected current-main workflow files. Post-divergence `commons-original-review.yml`, `constructor-editorial-audit.yml`, `editorial-photo-intake.yml` contain mutable action refs; driver/constructor/race research workflows already use immutable checkout SHA. `real-archive.yml` and `f1db-import.yml` differ between current `main` and #272, so a safe reconciliation must preserve the newer content/research jobs and artifacts.
- Created [draft PR #322](https://github.com/vlovers/grid-atlas/pull/322) from current `main` for two previously unpinned workflows. Exact head `458efdb4c942b2e9298eec747e5e9bbcb9756243`. Pins five mutable references to full commit SHAs across `constructor-editorial-audit.yml` and `editorial-photo-intake.yml`; preserves existing jobs, triggers, permissions, artifacts, and quarantine behavior. Commits: `679ef4a05659224ba4459cc8eb0d7d4e81733d6e`, `458efdb4c942b2e9298eec747e5e9bbcb9756243`. The connector returned **no PR-triggered runs and no combined statuses** for #322 head at this checkpoint; CI is unverified. No independent review.
- **Important credential exception:** photo-intake has `contents: write` and pushes a quarantine commit; persisted checkout credentials are needed by its existing push path. This conflicts with #272's blanket `persist-credentials: false` scanner. Explicit least-privilege push redesign or a narrow documented exception is required before declaring global compliance. Do not break the quarantine safety behavior by blindly disabling credentials.
- Added an integration handoff [comment on #272](https://github.com/vlovers/grid-atlas/pull/272#issuecomment-6430305924). No PR merged, no branch protection/ruleset changed, no releases published.

Next: inspect CI for #322 on its exact SHA; review the privileged photo-intake checkout/push boundary, then prepare a conflict-safe #272 reconciliation preserving current-main workflows. Independent reviewer identity and branch protection enforcement remain unverified.

**Exact-head CI follow-up for #322 (same checkpoint):** GitHub Actions subsequently returned **success** for all three observed PR-triggered runs on `458efdb4c942b2e9298eec747e5e9bbcb9756243`: [Foundation CI 40424061724](https://github.com/vlovers/grid-atlas/actions/runs/40424061724), [Constructor editorial F1DB identity audit 40424061748](https://github.com/vlovers/grid-atlas/actions/runs/40424061748), and [Stage editorial photo candidates 40424061656](https://github.com/vlovers/grid-atlas/actions/runs/40424061656). PR description updated with evidence. These runs do not prove every repository workflow or SHA-to-tag mapping. Independent approval and privileged checkout redesign remain outstanding; PR remains draft.


## 2026-10-27 03:00 — Step-scoped quarantine push credentials and upstream pin verification

- Rechecked [Grid Atlas #319](https://github.com/vlovers/grid-atlas/pull/319), [#322](https://github.com/vlovers/grid-atlas/pull/322), and [#272](https://github.com/vlovers/grid-atlas/pull/272). #319 remains draft/mergeable with head `6fd8ef4d6ac64acb2d3ad9979abfb05a09583f2e`; #272 remains open, nonmergeable, head `5dbec0773952fc417c8cebe40f67e226e2610b9f`. No merge or review approval was performed.
- Independently resolved the three release tags through the official GitHub commit endpoints: `actions/checkout@v4.3.1` = `34e114876b0b11c390a56381ad16ebd13914f8d5`; `actions/setup-node@v4.4.0` = `49933ea5288caeca8642d1e84afbd3f7d6820020`; `actions/upload-artifact@v4.6.2` = `ea165f8d65b6e75b540449e92b4886f43607fa02`. Updated #319 and #322 descriptions to record the verified mapping. Tag resolution is point-in-time; pinned SHAs remain immutable.
- Improved [draft #322](https://github.com/vlovers/grid-atlas/pull/322): `9dc817b2ac183d5e92bd9aa6f3ffbc8d837a1982` makes checkout `persist-credentials: false` and uses a `GH_TOKEN` environment variable scoped to the guarded quarantine push step. Git's temporary credential helper supplies the token for the single push without saving it to `.git/config` or embedding the secret in the command arguments. Verified the helper locally with a dummy token via `git credential fill` (not an authenticated GitHub push).
- Added `tests/editorial-photo-quarantine-auth.test.mjs` in `ba6720a07c0549ac1808a67776d5dbae340d4b8f` to protect SHA pins, non-persistent checkout, scoped token, and helper syntax. Exact-head [Foundation CI 40429974444](https://github.com/vlovers/grid-atlas/actions/runs/40429974444) **failed**: 351/352 Node tests passed; an older test required the literal `git push` invocation and rejected the helper-wrapped equivalent. [Constructor audit 40429974573](https://github.com/vlovers/grid-atlas/actions/runs/40429974573) and [photo candidate workflow 40429974614](https://github.com/vlovers/grid-atlas/actions/runs/40429974614) succeeded on that same head.
- Corrected the stale assertion in `tests/editorial-media-intake.test.mjs` at commit `8c81f67e68febb20fc4d6a0eb8aae6e65852d72b`. Latest PR #322 now has four changed files and is still draft/mergeable. On that exact head [constructor audit 40430056155](https://github.com/vlovers/grid-atlas/actions/runs/40430056155) and [photo candidate workflow 40430056073](https://github.com/vlovers/grid-atlas/actions/runs/40430056073) succeeded; [Foundation CI 40430056332](https://github.com/vlovers/grid-atlas/actions/runs/40430056332) was still in progress at this checkpoint. Do not mark it green until completion.
- Remaining security limitation: `contents: write` is still workflow-wide; evaluate splitting read-only discovery and write-only quarantine into separate jobs before approval. Actual named-branch quarantine push has **not** been exercised by these PR checks. Independent review remains outstanding. #272 still requires safe integration with newer `main` workflows; no branch protection/rulesets were changed, no release published, no PR merged.

Next: confirm exact-head Foundation CI result for #322; if green, review the workflow-level write permission boundary and prepare a separate minimal follow-up or documented security exception without changing product behavior.

**Exact-head CI completion for #322:** [Foundation CI run 40430056332](https://github.com/vlovers/grid-atlas/actions/runs/40430056332) finished **success** on `8c81f67e68febb20fc4d6a0eb8aae6e65852d72b`; its job log confirms **352/352 Node tests passed, 0 failed**. The constructor audit and photo candidate workflows also succeeded on that exact head. PR description updated. The named-branch authenticated quarantine push remains untested, and independent review is still missing.

## 2026-10-27 04:00 — Split photo intake into least-privilege jobs

- Rechecked live PR metadata: [Grid Atlas #319](https://github.com/vlovers/grid-atlas/pull/319) remains draft/mergeable at `6fd8ef4d6ac64acb2d3ad9979abfb05a09583f2e`; [#322](https://github.com/vlovers/grid-atlas/pull/322) was draft/mergeable at `8c81f67e68febb20fc4d6a0eb8aae6e65852d72b`; [#272](https://github.com/vlovers/grid-atlas/pull/272) remains open/nonmergeable at `5dbec0773952fc417c8cebe40f67e226e2610b9f`.
- Implemented the previously identified write-token isolation in draft #322: commit `6dd30717e796ef55aad0f271d9542fe592dfbbda` changes workflow-level permissions to `contents: read`, runs `stage` only for non-push events, and introduces a separate `quarantine` job restricted to push events on the named editorial branch with job-scoped `contents: write`. The quarantine job checks out with `persist-credentials: false` and does not execute branch-provided Node scripts. It retains the fixed-path removal and existing step-scoped credential-helper push behavior.
- Commit `8682ebca8a4fc8f493b64d81e50d010b7912aa29` updates the quarantine auth regression test to assert top-level read-only permissions, job-specific write permission, event restrictions, and no branch script execution in the privileged job. This is the current exact PR head after the two changes.
- At the latest check, three PR-triggered workflows (Foundation CI, Stage editorial photo candidates, Constructor editorial F1DB identity audit) had appeared for `8682ebca` and were **in progress**. No test success or failure is claimed yet for this new head. An authenticated push on the actual editorial branch remains untested.
- No merge, publication, ruleset/branch protection mutation, or product PR modification. Independent GitHub approval is still missing.

Next: inspect the three exact-head workflow conclusions, fix any regression without weakening gates, then assess #272 integration after #319/#322 have independent review and confirmed CI.


**04:00 CI refresh:** On exact SHA `8682ebca8a4fc8f493b64d81e50d010b7912aa29`, `Stage editorial photo candidates` completed successfully; `Foundation CI` and `Constructor editorial F1DB identity audit` remained in progress at the latest check. This does not exercise the named-branch quarantine push.

## 2026-10-27 05:00 — Fix photo quarantine trigger coverage

- Rechecked Grid Atlas [#319](https://github.com/vlovers/grid-atlas/pull/319) (draft, mergeable, head `6fd8ef4d`), [#322](https://github.com/vlovers/grid-atlas/pull/322) (draft, mergeable), and [#272](https://github.com/vlovers/grid-atlas/pull/272) (open, nonmergeable, head `5dbec077`). The #272 branch is currently **18 commits ahead / 31 behind** main, so the old workflow set cannot be considered comprehensive.
- Verified the three exact-head PR-triggered runs for previous #322 SHA `8682ebca8a4fc8f493b64d81e50d010b7912aa29` all completed **success**: [Foundation CI 40436257526](https://github.com/vlovers/grid-atlas/actions/runs/40436257526), [Constructor identity 40436257589](https://github.com/vlovers/grid-atlas/actions/runs/40436257589), and [Stage editorial photo candidates 40436257528](https://github.com/vlovers/grid-atlas/actions/runs/40436257528). These do **not** validate subsequent changes.
- Found a real quarantine bypass in #322: `push.paths` excluded the two public image files the quarantine job removes. Pushing only an unreviewed image would not trigger quarantine. Commit `ebb071fed6d622cb7b4906e9a9e38a9e0ebc91a8` adds both image paths to the branch-restricted push trigger. Commit `b76f34f31f87b6d2e0d49866f5b3722b19c8786b` adds regression coverage for the trigger/removal path correspondence and nonpersistent stage checkout credentials.
- Updated #322 description with the cause, fix, evidence and limitations. No PR-triggered runs were returned yet for new head `b76f34f31f87b6d2e0d49866f5b3722b19c8786b` at the time of this check; do not mark new-head CI green. Actual authenticated quarantine push on the editorial branch and independent review remain outstanding.
- No merge, release, branch protection/ruleset change or product PR modification.

Next: verify current-head CI for #322, then safely reconcile #272 with main after #319/#322 have independent review and validated checks. Do not disable existing accessibility gates or overwrite newer workflow behavior.

**05:00 new-head CI refresh:** For Grid Atlas #322 SHA `b76f34f31f87b6d2e0d49866f5b3722b19c8786b`, [Constructor identity 40441631683](https://github.com/vlovers/grid-atlas/actions/runs/40441631683) and [Stage editorial photo candidates 40441631625](https://github.com/vlovers/grid-atlas/actions/runs/40441631625) completed **success**; [Foundation CI 40441631628](https://github.com/vlovers/grid-atlas/actions/runs/40441631628) was still **in progress**. Static readback confirmed both protected paths are present in the push filter and the quarantine removal script. No submitted GitHub reviews were returned for #319, #322 or #272. These checks do not exercise an authenticated quarantine push.

**05:00 CI failure and correction:** Exact-head [Foundation CI 40441631628](https://github.com/vlovers/grid-atlas/actions/runs/40441631628) for `b76f34f` finished **failure**: one new regression assertion had an incorrectly double-escaped regex `/persist-credentials:\\s*false/`, despite the workflow containing the required setting. Fixed the test assertion (no workflow/security-policy changes) in #322 commit `047b24aafdacc83f0da13717fe2522553ccc59fc`. A static readback confirms the corrected regex matches the stage job. CI on this new head must be checked before claiming success. Previous-head constructor and photo workflows succeeded; the authenticated quarantine push remains untested.
