# Workflow acceptance matrix

This document separates historical evidence from candidate-specific checks.
It does not authorize production GitHub writes, merging, or deployment.

## 1. Real Coder → Reviewer → QA

**Existing evidence:** `docs/V0_7_VALIDATION.md` records a two-turn
local Codex trial on an earlier commit.

**Acceptance:** With explicit operator authorization, run
`npm run test:real:workflow` on the candidate using local Codex credentials
and a disposable repository. Record the commit, model, final state, and
evidence path. No retry, push, merge, or release is permitted.

## 2. Browser workflow and operator checkpoints

**Existing evidence:** `tests/browser-workflow-smoke.ts` exercises
workflow approvals and Review Center with synthetic transport.

**Acceptance:** Run `npm run test:browser:workflow` on the candidate.
In PR #77, this command runs both the workflow browser smoke test and
`tests/browser-workflow-restart.ts`. Verify rejected/stale approvals,
read-only Reviewer, QA report, and mobile rendering.

## 3. Backend restart and Dashboard reconnect

**Existing evidence:** PR #77 adds browser process-restart, session,
Dashboard, and workflow recovery coverage.

**Acceptance:** Verify a new successful browser-originated timeline
response after backend restart, rather than trusting cached UI text.
Confirm that interrupted, failed, stopped, and completed stages do not
replay. The live queue UI must drop the approved Coder while retaining
unrelated FIFO entries, matching the persisted Dashboard API. Preserve
session configuration and private execution bindings across restarts.
A second restart must not mutate blocked workflow versions. After explicit
cancellation, a third restart must keep the selected Workflow cancelled in
the live timeline, with no actionable downstream controls. The
"Workflow execution requires manual review after server restart." alert is
an intentional safety notice, not a transient connection error. The current
browser regression permits that notice and rejects other alerts observed after
reconnection. It also injects a synthetic HTTP 503 during subsequent live
polling against both the timeline and Dashboard endpoints and requires stale
Workflow actions **and the Create gated workflow form** to become disabled;
after transport recovery, errors must disappear and controls become available
again without reloading the page. Pausing live polling must also disable
Workflow creation, cancellation, and checkpoint mutations; resuming requires a
fresh successful refresh before these controls become actionable. A fresh
Dashboard response must also invalidate previously selected Coder tasks and
Reviewer/QA profiles that are no longer eligible; the creation button must
remain disabled rather than submitting stale React form state. The process
restart browser regression injects filtered Dashboard snapshots to exercise
missing Coder and Reviewer choices. A stacked Draft regression in PR #93
also holds a Dashboard response beyond the 3-second polling interval, asserts
that no second periodic Dashboard request overlaps it, and verifies that an
explicit operator refresh issues exactly one fresh Dashboard request (not two
reads through the mutation helper). A second
browser scenario pauses and resumes while a prior Dashboard response remains
held, requiring a successful new-generation response before controls unlock;
releasing the old response must not revoke that recovered state. These
regressions require a successful candidate-specific CI run before merge.
Marking PR #93 ready for review is not evidence. This does **not** prove that the persistent
manual-review notice always appears or that arbitrary delayed failures cannot
arrive after the observation window. Treat those as separate UX acceptance
gaps; do not suppress the notice merely to make a browser test pass.

## Stacked PR CI routing

`.github/workflows/validation.yml` validates pull requests targeting `main`
and `test/**` integration branches, plus pushes to `main`. PR #93 targets
PR #77's `test/workflow-restart-stage-matrix-20261025` branch; it must
receive its **own** successful Actions run on the exact candidate HEAD.
A green PR #77 run does not validate PR #93's additional polling code.
The workflow also supports manual `workflow_dispatch` when a rerun is
needed. Keep GitHub writes and live model calls disabled during CI.

## 4. Crash between recovery transactions

**Existing evidence:** PR #77 constructs the SQLite state after the
Store recovery commit and before Workflow recovery.

**Acceptance:** The deterministic regression must pass. This fixture
does not prove that a process was killed at that precise boundary.

## 5. Independent security review

**Existing evidence:** `docs/V0_7_WORKFLOW_ENGINE.md` describes
sandboxing, immutable evidence, and explicit approval gates.

**Acceptance:** Obtain an independent review of the candidate and
native sandbox compatibility. Author comments and self-review do not
count as independent approval.

## 6. Release and production delivery

**Existing evidence:** The historical validation is not a deployment
or release certificate.

**Acceptance:** Separately review backup/rollback, ingress/TLS,
operator grants, credentials, and least-privilege GitHub write access.
Workflow approval does not authorize production delivery.

## Safe execution order

1. Pin the candidate SHA and inspect open PRs for overlapping agent work.
2. Run formatting, lint, typecheck, tests, and build on that SHA.
3. Run deterministic workflow and browser restart suites with production
   credentials and GitHub writes disabled.
4. Inspect artifacts for unapproved execution, secret exposure, and
   unexpected changes to the primary checkout.
5. Only with explicit authorization, run the real local Codex smoke test.
6. Record the commit, CI run IDs, native host/CLI versions, test results,
   model evidence path, independent reviewer, and unresolved risks.
7. Do not declare release readiness without candidate-specific evidence.

## Known limits

- The live Codex trial in `docs/V0_7_VALIDATION.md` predates PR #77.
- Synthetic browser tests cannot establish real model review quality.
- The recovery commit-gap test simulates durable SQLite state.
- Workflow validation does not approve production GitHub writes.
- Alert inspection is a point-in-time check; deterministic post-reconnect notice
  visibility and delayed transport-error detection still require UX coverage.
