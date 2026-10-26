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

## Dashboard data contract (proposed)

One row per repository with `repository`, `integrationBranch`, `governancePr`, `ciRunUrls`, `ciState` (`passing|failing|pending|unknown`), `independentReview` (`approved|missing|unknown`), `branchProtection` (`verified|unverified`), `blockers`, `lastVerifiedAt`, and `evidenceUrls`. Never map unknown or pending to green. The dashboard should link to live GitHub evidence and clearly distinguish a historical snapshot from live status.
