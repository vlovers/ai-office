# MVP stabilization: integration baseline (2026-11-05)

> **Audit-only integration plan.** This file records the observed GitHub state on 2026-11-05, not a claim of a completed merge, a release, or a live Codex run. The repository's trusted product baseline remains `main` at `f85e45bfc0b31b774ddf20269b95f62a63a2d3c4` for this audit. Recheck all heads and checks before acting. This document deliberately does **not** authorize any merge, production remote write, or rollout.

## Goal and acceptance

Deliver a coherent local-first AI Office MVP: register a trusted repository, assign a versioned Agent Studio profile, explicitly submit an isolated Coder task, observe bounded persisted progress, inspect a revision-bound diff, request changes, run the gated Reviewer → native-sandbox QA workflow, and decide Keep/Reject. Verify a backend process restart and browser reconnection without silently retrying privileged work. Treat approved GitHub publication as a **separate, blocked** delivery milestone.

Acceptance must be reported at a specific commit SHA with evidence for:
1. `npm ci`, `npm run check`, `npm run format:check` on the actual integration tree.
2. Linux browser/HTTP/SSE fixtures, Agent Studio migration, Office navigation, isolated-write review, and workflow approval journey.
3. macOS native filesystem/supervisor, Reviewer/QA sandbox tests and browser workflow journey.
4. One **opt-in** real Codex local-login macOS trial using a disposable repository. Record provider/CLI version, output/cleanup and whether any allowance was spent; never add this to routine CI.
5. Real backend process kill/restart and **same-page** reconnect, including preserved FIFO order, interrupted/blocked state, and no automatic stage approval. Track against [#78](https://github.com/vlovers/ai-office/issues/78).
6. Independent security review for security-sensitive changes. Green CI and approval by the same author are not substitutes for independent review.
7. README, ROADMAP, changelog and release checklist updated only after the result has been demonstrated.

## Observed main baseline

- `main`: `f85e45bfc0b31b774ddf20269b95f62a63a2d3c4` (latest returned by repository commit search on 2026-11-05).
- `package.json` reports version `0.6.0`, Node 24, Fastify 5, React 19, Vite 8 and `@openai/codex-sdk` pinned to `0.162.1`. A package version is **not** proof of a published release.
- README/ROADMAP document v0.5.0 as the last tagged release; v0.6 Agent Studio, v0.7 workflow and Office V4 are integrated but not separately tagged.
- Existing runtime concurrency is **two** active turns, independent of saved profile count. Main dashboard is loopback-only. Delivery is separate and its remote-write HTTP endpoints remain disabled.
- The full working-tree test suite was **not run by this GitHub-side audit**; it cannot validate user-machine native Codex authentication, sandbox support, or filesystem state.

## Integration tracks (do not flatten blindly)

The following are actual observed PR refs and GitHub Actions results, not inferred merges. A successful Actions run is attached to the **listed SHA only**; retargeted or combined stacks require new validation.

| Track | PR / observed head | Observed base | Observed evidence | Required gate |
| --- | --- | --- | --- | --- |
| UI navigation root | [#106](https://github.com/vlovers/ai-office/pull/106) / `469c44a2570129164002d9fbbb8602cfad926a78` | `main` | [run 41435744952](https://github.com/vlovers/ai-office/actions/runs/41435744952), completed/success | Review 40-file scope, read-only lease retry and migration/browser UX before integration |
| Task live-log controls | [#165](https://github.com/vlovers/ai-office/pull/165) / `8e54025f42321316e00e3aac5dc0603f6bd9344b` | #164 head branch | PR describes pause, unread IDs and task-keyed scroll state | Validate through #164, then #165; no assumption of latest green CI |
| Terminal SSE retry | [#168](https://github.com/vlovers/ai-office/pull/168) / `73ff4e693edb7a6bf2d2577f948c7ece1aad1f24` | #166 head branch | [run 41489392389](https://github.com/vlovers/ai-office/actions/runs/41489392389) described as success in PR | Keep recovery read-only; no hidden task submission or duplicate stream |
| Workflow state coherence | [#173](https://github.com/vlovers/ai-office/pull/173) / `a5695bd43aa74b382a5b2a6d7b8310c3890169e6` | #172 head branch | [run 41566313264](https://github.com/vlovers/ai-office/actions/runs/41566313264), completed/success | Include #169 → #173 ancestors; verify exact Reviewer/QA navigation and fail-closed version mismatch |
| Mobile history | [#180](https://github.com/vlovers/ai-office/pull/180) / `204d9d0a8b41fb9d81a6048f9e0c5c2ffb4a4671` | #179 head branch | [run 41616172472](https://github.com/vlovers/ai-office/actions/runs/41616172472), completed/success | Include #174–#179 ancestry and test selected-task persistence and full CSV export |
| Stacked PR CI | [#167](https://github.com/vlovers/ai-office/pull/167) / `0669b6661d5c70fd0fd6b6d0cc84ae7d34002d6e` | `main` | [run 41569756279](https://github.com/vlovers/ai-office/actions/runs/41569756279), completed/success | Independently inspect workflow trigger/permissions; prove runs on feature-base PR **after** main integration |
| Action pinning | [#80](https://github.com/vlovers/ai-office/pull/80) / `730c209d87d003eba58a7420ea7bc9eecce91f6d` | `main` | [run 40216038559](https://github.com/vlovers/ai-office/actions/runs/40216038559), completed/success | **Block on [#81](https://github.com/vlovers/ai-office/issues/81)** independent security review and transitive action audit |
| QA cleanup hardening | [#163](https://github.com/vlovers/ai-office/pull/163) / `80e852fe7cf4efd03f04b5f18a5595f5b8a406ed` | security regression corpus branch | [run 41361476842](https://github.com/vlovers/ai-office/actions/runs/41361476842) described as success | Validate full security ancestor stack, not just two changed files |
| Delivery combined executor | [#79](https://github.com/vlovers/ai-office/pull/79) / `1de649111ad60f6e383b57d066650fe4ffdf4c53` | `main` | Prior green CI cited by PR body, not independently a current-head activation gate | **Block on [#84](https://github.com/vlovers/ai-office/issues/84), #58, #70** and separate operator/credential/live E2E gates |

### Explicit dependency and sequence policy

1. **Do not merge the tip of a long stack straight into main** without reviewing the entire difference from main, including its ancestor PRs. GitHub's small PR file count measures the diff against the branch parent, not the total integration scope.
2. Start with [#167](https://github.com/vlovers/ai-office/pull/167) because the workflow currently omits non-main PR targets. Review its workflow security, then validate new triggers on a harmless disposable feature-base PR. Its own green CI does not prove the trigger works from default branch.
3. For the UX baseline, review [#106](https://github.com/vlovers/ai-office/pull/106) independently, including the bounded read-only Git lease retry and the regression which originally surfaced as HTTP 409. A successful later run is useful evidence but not proof of zero races.
4. Integrate the UI log substack in dependency order: [#164](https://github.com/vlovers/ai-office/pull/164) → [#165](https://github.com/vlovers/ai-office/pull/165); separately [#166](https://github.com/vlovers/ai-office/pull/166) → [#168](https://github.com/vlovers/ai-office/pull/168). Verify each exact base/head before merging; these depend on the new UI root.
5. Integrate workflow state fixes in ancestor order (at least [#169](https://github.com/vlovers/ai-office/pull/169) → #170 → #171 → #172 → #173) and task-history changes (#174 → #175 → #176 → #177 → #178 → #179 → #180). Verify actual Git ancestry and overlaps immediately before integration; do not rely on PR titles as proof.
6. Keep security/CI supply-chain stacks and Delivery separate from UI stabilization. [#80](https://github.com/vlovers/ai-office/pull/80) requires [#81](https://github.com/vlovers/ai-office/issues/81); transitive composite-action coverage is tracked in [#82](https://github.com/vlovers/ai-office/issues/82). Security stacks such as #158–#163 require an independent review of effective combined source and checks.
7. **No automatic merge, release, deployment or GitHub write activation.** Resolve outstanding concerns, request the designated reviewer and obtain an explicit operator decision.

## Risks ranked by acceptance impact

| Priority | Risk | Mitigation / test |
| --- | --- | --- |
| P0 | Remote write activation or approval replay | Keep all remote-write HTTP routes disabled; follow Delivery production checklist and independent security review |
| P0 | Stacked branch accepted on unrelated/old CI | Require exact-head evidence and a final integration-tree CI run |
| P0 | Unknown Git lease / QA cleanup falsely treated as safe | Fail closed, preserve lease/artifacts, test both cleanup and recovery failures |
| P1 | Live page loses workflow/task truth on process restart | Real child-process crash and same-page Playwright reconnection test (#78) |
| P1 | Conflicting workflow summary/timeline/diagnostics | Cross-endpoint coherence, version gating, no actionable stale approval controls |
| P1 | Mobile page hides selected task or older log context | 320–390px browser coverage, progressive history and persisted SSE-ID tests |
| P1 | Release documentation confuses merged implementation with tagged release | Explicit release manifest: commit SHA, checks, native evidence, operator acceptance |

## Next coherent implementation batches

**Batch A — integrate and validate UX:** establish a disposable integration branch rooted at a freshly fetched main SHA; take #106 plus validated log/history/workflow UI stacks in verified ancestry order, settle duplicate changes, run all GitHub checks. Do not call this shipped until it is reviewed and merged. Output: one acceptance manifest with final SHA, changed file inventory, screenshot evidence, and remaining browser bugs.

**Batch B — restart reliability + native vertical slice:** implement/finish #78's actual backend process restart/same-page reconnect test; validate queue and workflow non-replay, then run the opt-in real Mac Codex workflow on a disposable repository. Output: reproducible test report and blocker list, no inference about Linux native success.

**Batch C — security & delivery separation:** review #80/#81/#82 and independent security stack; complete #84/Delivery gates separately. Delivery remains off by default. Only after approval should an authenticated, revision-pinned Draft PR flow become a candidate for a distinct release.

## Evidence and reporting protocol

For each batch record: baseline SHA, candidate SHA, PR ancestry and changed-file inventory, Linux and macOS check URLs with exact result, manual-review identity, real-provider tests if run, unresolved failures, rollback path, and a clear **PASS / BLOCKED / NOT RUN** status. Never report tests as run based solely on README instructions or a PR's prose. Preserve previously approved worktree/SQLite data and never delete unknown leases to make tests pass.

This plan is an **audit deliverable**, not a code integration. The follow-up must execute and validate the actual batches above.
