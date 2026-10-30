# Combined workflow, QA and browser integration — 2026-10-30

This document supersedes the earlier #113-only acceptance notes. It describes
the **Draft PR #116 candidate** at
`c2da6f3e652b805305ac26b7d242a2e1bbb43f05`. Neither this evidence nor
a green CI authorizes a merge, deployment or production write.

## Dependency graph and actual inclusion

- Workflow recovery and replay prevention: #95 → #96 → #107 → #108.
- Native QA supervision and fail-closed security: #97 → #103 → #110.
- Browser stale responses and checkpoint confirmations: #95 → #111 → #112.
- Combined server integration: #108 + #110 → #113.
- Final browser/server integration: #113 + #112 → #116.

The audit also compares the current `main` commit against #116. Merely
checking a PR's `base.sha` is insufficient: GitHub updates that pointer when
`main` moves, even if the integration branch has not incorporated the new
commit.

GitHub commit comparisons on 2026-10-30 confirmed that the exact heads of
#108 (`42982df`), #110 (`6dc3fc2`), #112 (`629981d`) and #113
(`737db92`) are ancestors of #116, with `behind_by=0`.

**Important non-ancestry exception:** #109 is not an ancestor of #116. Its
approved-executable implementation was copied into #110. The blob SHA of
`src/server/qa-runner.ts` is identical in #109 and #116
(`fa71350ba52e259b3aab73a4f9da9f30dc4c1a83`), as is the race regression
`tests/qa-plan-preflight-race.test.ts`
(`d93b638de7b9da855055eb57577ddd0e15fdd437`).
`tests/qa-runner.test.ts` is **not** byte-identical; the combined security
branch contains additional tests. These content pins complement, rather than
replace, independent review of the integration.

## Verified CI evidence

The GitHub Actions run
[40990498627](https://github.com/vlovers/ai-office/actions/runs/40990498627)
completed successfully for exact #116 HEAD `c2da6f3e`. Both the Linux
`TypeScript, tests, smoke, build and formatting` and macOS
`Native Codex filesystem policy (no inference)` jobs completed successfully.
The exact heads of #95, #96, #97, #103, #107, #108, #109, #110, #111, #112
and #113 also had completed successful validation runs when checked on
2026-10-30. This is historical evidence, not a promise about future commits.

## Reproducible read-only stack audit

Run `node --test tests/pr-stack-audit.node.mjs` to exercise the **offline**
regressions for branch drift, stale CI, missing native jobs, lost merge ancestry,
and changed copied security files. The CI workflow runs these tests without
network, provider credentials, or production access.

Run `node scripts/pr-stack-audit.mjs vlovers/ai-office` to query GitHub's
public read-only API for the current branch graph, CI evidence, exact source
ancestry and copied security file SHA checks. An optional `GITHUB_TOKEN`
increases API rate limits; the script never performs a write. The command
returns nonzero when evidence is missing, pending, stale or contradictory.
CI evidence is tied to the exact pull request, latest run ID and attempt,
not merely a shared commit SHA. The candidate's Linux and macOS jobs must
both belong to that run and attempt; duplicate, missing or truncated job
records fail closed. All candidate job pages are fetched before evaluation.
GitHub API failures are blockers, **not** successful validation. This tool
checks the known stack; it does not discover every future PR or replace a
human code review.

## Outstanding release gates

1. Obtain an independent security review of process groups, supervisor IPC,
   native sandbox failure-close, QA executable identity and approval gates.
2. Review conflicts and source changes made after the pinned candidate heads.
   If any branch advances, rerun the audit and all candidate CI jobs.
3. Confirm rollback/backup, deployment and production security separately.
   Synthetic tests intentionally never invoke real model providers.
4. Do not merge or deploy from this integration Draft without explicit
   authorization.
