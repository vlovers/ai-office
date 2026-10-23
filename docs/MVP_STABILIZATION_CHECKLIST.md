# MVP stabilization acceptance checklist

## Post-merge Office V4 baseline (2026-10-24)

- [x] Office V4 and workflow/task operations merged in [PR #36](https://github.com/vlovers/ai-office/pull/36) (`main` commit `f2c08c3`).
- [x] Required integration PR CI passed on head `0797b5a` ([run](https://github.com/vlovers/ai-office/actions/runs/39944462519)).
- [ ] Perform real authenticated Codex-provider task and review journey on the integrated version.
- [ ] Complete supported-host restart/soak, security/credential review and Linux native success-path verification.
- [ ] Independently review actual responsive screenshots, keyboard focus, text scaling and reduced-motion behavior.
- [ ] Record final release-candidate SHA and obtain explicit approval before any tag/deployment.

The older checklist below is retained for historical gate definitions. Any statement that Office V2/V3 is still an unmerged PR is outdated.


This checklist describes **required evidence**, not a claim that the tests have passed. Keep release claims separate from merged implementation.

## Current baseline (2026-10-23)

- [x] Workflow Operations PR #25 merged into `main`; latest PR-head validation #327 succeeded before merge.
- [x] v0.7 Workflow Engine merged via PR #24; this is implementation integration, not a tagged release.
- [x] Office Experience V2 PR #27 merged at `b3f7ee9`; confirmed from current main history.
- [ ] Office Experience V4 is implemented in PR #31; final PR CI/review remains separate from release approval. See [sprint evidence](OFFICE_V4.md).
- [x] Documentation synchronization PR #28 merged at `5e160bd`; confirmed from current main history.

## Gate A — Office Experience V2

- [x] Integrate [PR #27](https://github.com/vlovers/ai-office/pull/27) against main.
- [ ] Review and integrate [Office V4 PR #31](https://github.com/vlovers/ai-office/pull/31) after final CI.
- [ ] Run the repository's exact Prettier version with `npm run format:check`.
- [ ] Run `npm run check`, `npm run test:sandbox`, and all relevant browser suites on the final commit.
- [ ] Verify agent selection, occupied/idle seats, overflow roster, persisted history, responsive viewport, keyboard focus, reduced motion and error/empty states in a real browser.
- [ ] Confirm no presentation control dispatches work or escalates permissions without a server-enforced approval.

## Gate B — Workflow and runtime

- [ ] Exercise read-only review with the installed supported Codex CLI and a disposable registered repository.
- [ ] Exercise approved isolated-write task and verify the primary checkout and common Git metadata are unchanged.
- [ ] Exercise Coder → Reviewer → QA with explicit approval of baseline, evidence, reviewer input/result and QA command/result.
- [ ] Verify failed/denied approval, stale revision, cancellation and backend restart fail closed without silent redispatch.
- [ ] Inspect logs and browser payloads for leaked keys, credentials, private paths and unsafe HTML rendering.
- [ ] Verify cleanup/lease behavior and record residual worktrees or manual recovery steps.
- [ ] Do not assert Linux native sandbox support without a native success-path run on Linux.

## Gate C — First-run UX

- [ ] Confirm Node 24, Git and supported Codex CLI are detected or reported with actionable errors.
- [ ] Confirm local login does not silently fall back to API-key billing.
- [ ] Confirm users can register a trusted repository, create an agent profile, submit a read-only task and inspect the result without guessing the next step.
- [ ] Confirm missing workspace roots, unsupported sandbox and unavailable CLI fail with safe explanations.

## Gate D — Release truth

- [ ] Confirm actual tags/releases before choosing the next version; do not infer a release from `package.json`.
- [ ] Align README, CHANGELOG, ROADMAP, architecture, validation, release notes and package version with that decision.
- [ ] Capture final commit SHA, CI URLs, native test environment and known limitations.
- [ ] Create tag/release only after Gates A–C pass and release approval is explicit.

## Explicitly deferred

Multi-user hosting, automatic merges/push/deploy, unverified provider adapters, unbounded concurrency and claims of generalized filesystem secrecy are outside the current MVP.
