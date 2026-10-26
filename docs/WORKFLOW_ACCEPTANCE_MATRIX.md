# Workflow acceptance matrix — operator-facing release gate

This document separates evidence already recorded from tests that must still run on
the exact candidate commit. It does **not** authorize production GitHub writes,
automatic approval, merging, or deployment.

## Evidence and acceptance gates

| Gate | Existing evidence | Candidate acceptance requirement |
| --- | --- | --- |
| Coder → Reviewer → QA | `docs/V0_7_VALIDATION.md` records a two-turn local Codex trial on an earlier commit. | Explicit opt-in `npm run test:real:workflow` on the candidate with local Codex credentials, a disposable repository, and no retry or push. Record commit, model, terminal state, and evidence path. |
| Browser operator journey | `npm run test:browser:workflow` exercises workflow approvals and Review Center with synthetic transport. | Green browser suite on the candidate; inspect failed/stale approval, read-only Reviewer, QA report, and mobile rendering. |
| Real backend restart and Dashboard reconnect | PR #77 adds `tests/browser-workflow-restart.ts` and restart/session/unit suites. | Green `npm run test:browser:workflow:restart` **if that script exists on the candidate**; verify a new successful browser-originated timeline response after process restart, not just cached UI text. |
| Durable queue and workflow recovery | PR #77 covers interrupted/failed/stopped/completed Reviewer and QA stages, unrelated FIFO order, and repeated recovery. | Verify no Reviewer/QA replay, no unapproved resume, no changed workflow versions after a second restart, and ordinary queue/session preservation. |
| Crash between recovery commits | PR #77 includes a deterministic SQLite intermediate-state fixture. | Confirm the fixture passes; it simulates the persisted boundary and does **not** establish that a process was killed precisely between the commits. |
| Security and review | Native sandbox, immutable evidence, and explicit approval gates are described in `docs/V0_7_WORKFLOW_ENGINE.md`. | Independent security review of candidate changes and native sandbox compatibility; review comments or author self-review do not count as independent approval. |
| Release and production delivery | Existing validation is not a deployment or release certificate. | Separate backup/rollback, ingress/TLS, credentials, operator grants, and least-privilege GitHub write authorization review. |

## Safe execution order

1. Pin the candidate commit SHA and record the current open PRs to avoid mixing
   unrelated agent work. Run formatting, lint, typecheck, tests, and build.
2. Run deterministic workflow, browser, restart, and Dashboard tests on that
   same commit. Keep all credentials and production GitHub writes disabled.
3. Inspect the failure artifacts and confirm no unexpected task execution,
   unapproved stage transition, secret exposure, or changed primary checkout.
4. **Only after explicit operator authorization**, run the real local Codex
   smoke script against its new disposable repository. The script requires
   `--run`, consumes real model turns, and does not perform push/merge/release.
5. Record exact commit, CI run IDs, native host/CLI versions, test results,
   model-trial evidence location, independent reviewer, and unresolved risks.
6. Do not mark the workflow release-ready until all applicable gates have
   concrete candidate-specific evidence. A green unit suite alone is not enough.

## Known limits

- The historical live Codex trial in `docs/V0_7_VALIDATION.md` predates PR #77.
- Synthetic browser tests prove UI orchestration and reconnect behavior, not
  the quality of a real model review.
- The restart commit-gap test uses a deliberately constructed durable SQLite
  state rather than a precisely timed process kill.
- Approval of workflow tests does not imply approval of delivery automation,
  GitHub writes, production ingress, or deployment.
