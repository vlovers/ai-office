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

