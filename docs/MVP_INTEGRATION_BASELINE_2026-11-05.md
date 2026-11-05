# MVP integration baseline — 2026-11-05

> Audit only. This plan does not authorize a merge, deployment, release, or
> production GitHub write. Verify all PR heads and CI again before integration.

## Goal

Deliver a coherent local-first AI Office MVP: register a trusted repository,
assign a versioned Agent Studio profile, explicitly submit an isolated Coder
task, follow persisted progress, inspect revision-bound Git changes, request
corrections, approve a Reviewer and sandboxed QA result, then Keep or Reject.

GitHub Delivery is a separate milestone. Remote-write HTTP endpoints remain
disabled until independent security review and operational approval.

## Observed baseline

- `main` head: `f85e45bfc0b31b774ddf20269b95f62a63a2d3c4`.
- `package.json`: Node 24, Fastify 5, React 19, Vite 8, Codex SDK
  `0.162.1`, package version `0.6.0`.
- README/ROADMAP: v0.5 is the last tagged release. Agent Studio, workflow
  orchestration and Office V4 are merged implementations without separate tags.
- Saved agent profiles share a maximum of two concurrently active turns.
- The dashboard is loopback-only. Delivery is separate; remote writes are off.
- This audit inspected GitHub sources and checks. It did not run local build,
  Playwright, a native sandbox test or a real provider session.

## Observed integration tracks

Each SHA and linked workflow run applies **only** to that revision. A stacked
branch retarget or a combined integration tree needs its own verification.

- **UI root:** [#106](https://github.com/vlovers/ai-office/pull/106),
  `469c44a2570129164002d9fbbb8602cfad926a78`.
  [CI 41435744952](https://github.com/vlovers/ai-office/actions/runs/41435744952)
  succeeded. Review the full UI diff and bounded read-only Git lease retry.
- **Live log:** [#164](https://github.com/vlovers/ai-office/pull/164)
  precedes [#165](https://github.com/vlovers/ai-office/pull/165),
  `8e54025f42321316e00e3aac5dc0603f6bd9344b`.
- **Terminal SSE:** [#166](https://github.com/vlovers/ai-office/pull/166)
  precedes [#168](https://github.com/vlovers/ai-office/pull/168),
  `73ff4e693edb7a6bf2d2577f948c7ece1aad1f24`.
- **Workflow state:** [#169](https://github.com/vlovers/ai-office/pull/169)
  through [#173](https://github.com/vlovers/ai-office/pull/173),
  `a5695bd43aa74b382a5b2a6d7b8310c3890169e6`.
  [CI 41566313264](https://github.com/vlovers/ai-office/actions/runs/41566313264)
  succeeded on that final SHA.
- **Mobile history:** [#174](https://github.com/vlovers/ai-office/pull/174)
  through [#180](https://github.com/vlovers/ai-office/pull/180),
  `204d9d0a8b41fb9d81a6048f9e0c5c2ffb4a4671`.
  [CI 41616172472](https://github.com/vlovers/ai-office/actions/runs/41616172472)
  succeeded on that final SHA.
- **Stacked-PR CI:** [#167](https://github.com/vlovers/ai-office/pull/167),
  `0669b6661d5c70fd0fd6b6d0cc84ae7d34002d6e`.
  [CI 41569756279](https://github.com/vlovers/ai-office/actions/runs/41569756279)
  succeeded. Verify feature-base triggering after integration in `main`.
- **Action SHA pinning:** [#80](https://github.com/vlovers/ai-office/pull/80),
  `730c209d87d003eba58a7420ea7bc9eecce91f6d`.
  [CI 40216038559](https://github.com/vlovers/ai-office/actions/runs/40216038559)
  succeeded, but [#81](https://github.com/vlovers/ai-office/issues/81)
  independent review and
  [#82](https://github.com/vlovers/ai-office/issues/82) transitive
  composite-action inspection remain gates.
- **QA HOME cleanup:** [#163](https://github.com/vlovers/ai-office/pull/163),
  `80e852fe7cf4efd03f04b5f18a5595f5b8a406ed`,
  remains on a separate security ancestry stack.
- **Delivery:** [#79](https://github.com/vlovers/ai-office/pull/79),
  `1de649111ad60f6e383b57d066650fe4ffdf4c53`,
  stays blocked by [#84](https://github.com/vlovers/ai-office/issues/84),
  [#58](https://github.com/vlovers/ai-office/issues/58) and
  [#70](https://github.com/vlovers/ai-office/issues/70).

## Integration rules

1. Check every actual parent/head ancestry and compare with current `main`.
   Small PR diffs against feature parents do not describe the cumulative scope.
2. Integrate feature-base CI support after reviewing workflow trust and token
   permissions. Verify the trigger from the new default branch.
3. Review #106 as the UI root before relying on follow-up task/event UX.
4. Validate the task-log and SSE recovery path without silent task execution.
5. Validate workflow stages and history in their dependency order. Preserve
   fail-closed approval gates and full filtered CSV export.
6. Keep the supply-chain security stack and Delivery entirely separate.
   Require independent review at the exact candidate SHA.
7. Do not merge, deploy, publish, retry ambiguous writes or run real inference
   solely because an ancestor has green CI.

## Required MVP evidence

- `npm ci`, `npm run check` and `npm run format:check` on the integrated tree.
- Linux Playwright UI, migration, HTTP/SSE, isolated review and workflow tests.
- macOS native supervisor, sandbox, Reviewer and QA approval journey.
- Genuine backend process restart with the **same** open browser page, unchanged
  queue order, no privileged replay, and safe interrupted/blocked states.
  Track [#78](https://github.com/vlovers/ai-office/issues/78).
- Opt-in real Codex run against a disposable repository with sanitized evidence
  and documented allowance use. This is not a normal CI task.
- Independent review, rollback instructions and exact-SHA approval records.
- Release documentation updated only after the required tests actually pass.

## Coherent batches

**Batch A — integrated UI.** Combine the five-destination Office navigation,
live task logs, terminal SSE recovery, workflow checkpoint reliability and
progressive mobile history in one reviewed integration tree. Record exact
file scope, browser screenshots and the required Linux/macOS CI.

**Batch B — restart and native acceptance.** Complete the process restart and
same-page reconnection scenario from #78. Run the opt-in native local-login
vertical slice, preserving independent queue and permission gates.

**Batch C — security and Delivery.** Resolve #81/#82 and other security stack
reviews; finish #84 and production Delivery checklist independently. Do not
enable remote write routes without separate approval.

## Reporting

For every batch, record the base and candidate SHA, branch ancestry, changed
files, exact CI URLs and results, independent reviewer identity, native tests
actually run, unresolved blockers, and rollback steps. Use **PASS**, **BLOCKED**
or **NOT RUN** rather than inferring success from documentation.

This file is an audit deliverable, not proof that the MVP is finished.
