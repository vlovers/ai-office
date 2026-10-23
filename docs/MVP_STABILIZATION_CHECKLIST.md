# AI Office MVP stabilization acceptance checklist

> Updated 2026-10-23 against `main` `b3f7ee9`. This is an **acceptance plan**, not a record of fresh successful tests. See [repository audit](REPOSITORY_AUDIT_2026_10_23.md) and [roadmap](../ROADMAP.md).

## Current integration baseline

- [x] v0.6 Agent Studio merged into main (not tagged).
- [x] v0.7 Workflow Engine PR #24 and Workflow Operations PR #25 merged into main (not tagged).
- [x] Office Experience V2 PR #27 merged into main.
- [x] Documentation synchronization PR #28 merged into main.
- [ ] Office Experience V3 PR #31 remains Draft; inspected CI run #363 failed Prettier. No merge/release claim.
- [ ] Re-run complete validation on the eventual release candidate SHA.

## Gate A — Source, CI and UI

- [ ] Pin candidate commit SHA, Node/OS/Git/CLI/SDK versions and exact commands.
- [ ] `npm ci && npm run format:check && npm run check` pass on candidate.
- [ ] `npm run test:browser`, `npm run test:browser:write`, `npm run test:browser:studio` and `npm run test:browser:workflow` pass in supported environments.
- [ ] `npm run test:sandbox` and `npm run test:workflow:native` pass on macOS.
- [ ] Inspect actual desktop/mobile screenshots; test 200% text, keyboard focus, reduced motion, empty/offline/blocked/error states and multiple agent profiles.
- [ ] Verify no UI interaction bypasses explicit server-side permissions or approval checkpoints.
- [ ] Resolve V3 CSS/TSX formatting and browser failures, or defer V3 without claiming it shipped.

## Gate B — Real Codex and safety

- [ ] Run a read-only task using supported installed Codex CLI and a disposable registered repository.
- [ ] Explicitly authorize isolated write; verify primary checkout/common Git metadata stay unchanged.
- [ ] Exercise persisted session resume and restart with compatible authentication/configuration.
- [ ] Exercise revision-bound Request Changes, Keep/Reject and stale review rejection.
- [ ] Exercise Coder → Reviewer → QA with baseline/evidence/input/result approvals.
- [ ] Test denied/dismissed approval, cancellation, stale revision, interrupted worker, uncertain cleanup and recovery diagnostics.
- [ ] Inspect logs, browser payloads and reports for known credential/private-path exposure; do not claim universal secret detection.
- [ ] Record remaining worktrees, leases and any manual recovery actions.
- [ ] Do not claim Linux native support without a real supported-host success-path test.

## Gate C — First-run operator journey

- [ ] Detect Node 24, Git, supported Codex CLI and existing local login with actionable failures.
- [ ] Ensure no silent API-key billing fallback.
- [ ] Register trusted repository, create/select profile, create/start task and inspect streamed/final result.
- [ ] Find task/session/review/QA and permission context without guessing UI navigation.
- [ ] Explain blocked permissions, unavailable CLI, invalid roots and disconnected backend safely.
- [ ] Review time-to-first-task, error recovery and usability on desktop/mobile.

## Gate D — Delivery and release truth

- [ ] Confirm actual GitHub tags/releases; select version only after acceptance.
- [ ] Align `README.md`, `CHANGELOG.md`, `ROADMAP.md`, architecture, validation, screenshots and release notes with shipped behavior.
- [ ] Record exact commit SHA, CI run URLs, local real-model evidence and limitations.
- [ ] Obtain explicit operator approval for tag/release; do not auto-merge, push user changes or deploy.
- [ ] Leave PR #31 Draft until its independent CI and visual review gates pass.

## Deferred beyond local MVP

GitHub PR publishing, recurring schedules, dependency-aware autonomous delegation, multi-user hosting, unverified provider adapters, unbounded concurrency and automatic merge/deploy.
