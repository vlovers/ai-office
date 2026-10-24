# MVP stabilization acceptance checklist

This checklist describes **required evidence**, not a claim that the tests have passed. Keep release claims separate from merged implementation.

## Current baseline (2026-10-24)

- [x] Workflow Operations PR #25 merged into `main`; latest PR-head validation #327 succeeded before merge.
- [x] v0.7 Workflow Engine merged via PR #24; this is implementation integration, not a tagged release.
- [x] Office Experience V2 PR #27 merged at `b3f7ee9`; confirmed from current main history.
- [x] Office Experience V4 integrated into `main` through [PR #36](https://github.com/vlovers/ai-office/pull/36); PR #31 was superseded. This proves integration only, not release acceptance. See [sprint evidence](OFFICE_V4.md).
- [x] Documentation synchronization PR #28 merged at `5e160bd`; confirmed from current main history.

## Gate A — Office Experience V4

- [x] Integrate [PR #27](https://github.com/vlovers/ai-office/pull/27) against main.
- [x] Integrate [Office V4 PR #36](https://github.com/vlovers/ai-office/pull/36) against `main` (supersedes PR #31). Reconfirm tests on the exact release candidate SHA; merged CI is not acceptance evidence.
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

## Delivery activation is a separate gate

The current local-first MVP does **not** require enabling Delivery remote writes. For a future GitHub Draft PR release, keep commit/push/publication routes disabled until [#58](https://github.com/vlovers/ai-office/issues/58), [#68](https://github.com/vlovers/ai-office/issues/68) and [#70](https://github.com/vlovers/ai-office/issues/70) are independently validated. See [Delivery production checklist](DELIVERY_PRODUCTION_CHECKLIST.md) and [MVP evidence and activation gates](MVP_EVIDENCE_AND_ACTIVATION_GATES.md). Never conflate the dedicated Delivery API with the local dashboard.

## Explicitly deferred

Multi-user hosting, automatic merges/push/deploy, unverified provider adapters, unbounded concurrency and claims of generalized filesystem secrecy are outside the current MVP.
