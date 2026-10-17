Current release preparation and the real-model approval gate are tracked in [v0.4.0 release verification](V0_4_RELEASE_VERIFICATION.md). The records below retain their original audit scope.

# v0.4 security-audit verification — 2026-10-18

Environment: macOS arm64, Node 24.21.0, installed Codex SDK/CLI 0.162.1. Baseline PR head was `6353783`; hardening implementation is commit `67d29be`. No inference calls were used. All Git/database/process fixtures were disposable; synthetic canaries stood in for secrets.

| Gate                            | Actual result                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                 | Passed: TypeScript, complete unit/integration suite, HTTP/SSE smoke and production build                                                                                                             |
| `npm test`                      | **73/73 passed**, 10 files, **101.66 seconds**                                                                                                                                                       |
| `npm run test:smoke`            | **2/2 passed**, **6.82 seconds**                                                                                                                                                                     |
| TypeScript and production build | Passed; server TypeScript plus Vite frontend                                                                                                                                                         |
| `npm run format:check`          | Passed; repository has no separate lint script                                                                                                                                                       |
| `git diff --check`              | Passed                                                                                                                                                                                               |
| `npm run test:sandbox`          | Passed credential-free installed runtime probe: both profiles, outside/sensitive/nested paths, symlink escapes, actual linked-worktree Git-pointer removal/rename denied, primary checkout preserved |
| Existing browser workflow       | Passed read-only/session/SSE/queue/stop/resume, keyboard/reduced motion, 320–1440px, no page errors                                                                                                  |
| Write browser workflow          | Passed dismissed write/reject confirmations, real Git diff, revision-bearing decisions, opt-in host verification/result persistence, keyboard focus, responsive widths and primary preservation      |
| Optional real Codex write smoke | Inspected, not executed without explicit usage approval. Failed-run fixtures are retained for inspection. No paid model usage is required in CI.                                                     |

GitHub's original PR run [39070478525](https://github.com/vlovers/ai-office/actions/runs/39070478525) was green before this audit. Current hardening-head Linux checks and the added credential-free macOS native sandbox job are linked from [PR #7 checks](https://github.com/vlovers/ai-office/pull/7/checks); their final results are recorded in the PR review summary. This document does not count a queued CI job as a pass. Linux native sandbox behavior is not attested by the macOS job.

Reproductions before fixes: wildcard-pathspec secret-filter bypass, host clean-filter execution, ignored/bare-repository data deletion, same-path worktree replacement, and Git metadata outside the authorized root all failed their new negative assertions. After hardening those assertions pass. Fault-injection tests cover creation intent, transactional rollback, rejection followed by a failed SQLite update, interrupted verification/removal and restart. Concurrent write/alias tests, advanced HEAD, post-auth identity/HEAD changes, mode compatibility and uncertain-cleanup lease retention are covered.

Process tests prove independent timeout/disconnect handling after an abrupt fixture backend death, bounded descendant-held output, shutdown abort, no inherited synthetic host secret, and conservative EPERM handling. The initial strict cleanup attempt exposed a transient macOS EPERM; bounded retry still requires delivered SIGKILL or confirmed absence. Persistent denied cleanup remains a failure with a retained lease. Assertions were not weakened to treat EPERM as termination.

The expanded native probe initially exposed that a directory-only nested deny glob did not cover a descendant file; explicit descendant globs fixed it. It then passed, including a real linked worktree and Git pointer. The outer execution sandbox cannot apply macOS sandbox-exec policies or always inspect orphan groups, so native/process tests ran outside that outer boundary. Browser checks use `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/ai-office-playwright` and disposable loopback ports.

Remaining boundaries: metadata revisions are not atomic snapshots against outside editors; deny globs have platform/depth/timing limits; host verification grants OS/network permissions only after operator opt-in and separate confirmation; process groups do not contain deliberately detached programs; stale locks and ambiguous ownership require manual recovery. See [the audit](V0_4_SECURITY_AUDIT.md), [security model](SECURITY.md), and [workspace recovery](WORKSPACE_RECOVERY.md). No real-model write execution is claimed by deterministic transport tests.

The records below are historical and are not the security-audit test totals.

# Earlier v0.4 implementation validation (before security audit)

Local verification: macOS arm64, Node 24.21.0, installed SDK/CLI 0.162.1, 2026-10-18 (Europe/Kyiv). No model calls or credential reads were used for v0.4 validation.

| Check                                       | Result                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                         | Passed                                                                                                                                                                   |
| `npm test`                                  | 50/50 tests passed in 9 files; 45.50 s                                                                                                                                   |
| Final targeted workspace safety rerun       | 9/9 passed in 10.71 s                                                                                                                                                    |
| `npm run test:smoke`                        | 2/2 HTTP/SSE tests passed in 6.91 s                                                                                                                                      |
| `npm run build`                             | Passed, TypeScript server + Vite production frontend                                                                                                                     |
| `npm run format:check`                      | Passed; this repository uses Prettier as its style gate and has no separate lint command                                                                                 |
| `git diff --check`                          | Passed                                                                                                                                                                   |
| `npm run test:sandbox`                      | Installed runtime allowed isolated writes; denied primary/sibling, known secret and Git metadata writes; read-only profile still denied writes                           |
| `npm run test:browser`                      | Passed existing Chromium regression, keyboard/reduced-motion, 320–1440px, no page errors                                                                                 |
| `npm run test:browser:write`                | Passed confirmation dismissal, isolated changes, live Git diff, verification persistence, keyboard diff focus, responsive widths, confirmed rejection, primary unchanged |
| Optional `npm run test:real:write -- --run` | Added, intentionally not executed; consumes existing CLI-authenticated usage, never normal CI                                                                            |

Browser commands used `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/ai-office-playwright`. The default cache had no Chromium. The outer execution sandbox blocked native macOS sandbox application/process-group probes; those checks passed when rerun outside that outer boundary. Initial browser-write selector expected an exact Register label despite its arrow suffix; corrected the test selector and reran successfully. The final rerun also exposed a transient EPERM in the pre-existing orphan-group probe. It now conservatively retries EPERM as potentially alive, still requiring ESRCH to prove termination; the full suite then passed. Assertions were retained.

The workspace fixtures cover clean and dirty-primary isolation, existing branches/paths, authorization/traversal/symlink checks, nested repository protection, added/modified/deleted/committed diffs, sensitive paths, failed cleanup, committed and kept cleanup refusals, uncommitted rejection, bounded failing verification, saved review identity, stop/failure and restart/resume. Git is the source of truth; the fake CLI drives the installed SDK transport without inference.

Known limits: trusted single-user host; verification is trusted code with OS permissions; worktrees share Git metadata; external editors do not honor leases; stale locks and creation orphans require manual inspection. No Linux execution was performed locally; deterministic Linux checks are configured in CI. Windows remains unsupported. Native transcripts are required for resume. Large/sensitive/binary diffs and committed/nested/large-tree cleanup may require local review.

The historical v1.2 evidence below describes the baseline, not a new real-model v0.4 test.

# Verification record

Historical phase: **1.2**. Environment: macOS arm64, Node 24.21.0, official Codex SDK/existing CLI **0.162.1**. Local verification date: **2026-10-16** (live-run timestamp is UTC on 2026-10-15).

| Check                         | Actual result                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                    | `npm run typecheck` passed, including backend/frontend/test/probe sources                                                                                                                                           |
| Unit/integration tests        | `npm test`: 20 tests across 5 files; auth selection, missing/expired login, sanitized errors, no fallback, environment filtering, mode/context validation, migration/persistence, process failures and cancellation |
| Deterministic HTTP/SSE smoke  | `npm run test:smoke`: passed through real SDK/CLI fixture, SSE/replay/results, then a new backend/provider/auth service/SQLite connection before resume                                                             |
| Production build              | `npm run build` passed                                                                                                                                                                                              |
| Formatting                    | `npm run format:check` passed                                                                                                                                                                                       |
| Fixture browser               | Production React/Fastify flow passed with explicit local/API mode choice, task start, live result, history, desktop/mobile checks and shutdown while browser connections remain                                     |
| Native sandbox                | Registered-file reads allowed; outside/secret reads and repository writes denied; no model call or credentials                                                                                                      |
| **Real production dashboard** | **Passed** using existing ChatGPT login with API keys excluded; initial task **8.402 s**, resume after real backend restart **4.854 s**, overall **17.207 s**                                                       |
| Real model/thread             | `gpt-6.1-sol`, confirmed in persisted native metadata; same thread `<redacted-thread-id>` across restart                                                                                                            |
| Real task safety              | Disposable Git worktree unchanged; no credentials opened/copied by application code; no API-key fallback; clean backend shutdown                                                                                    |
| Live API mode/cancellation    | Not exercised with a real model; API mode and cancellation paths are covered deterministically                                                                                                                      |
| Linux/Windows                 | Linux remains unverified; Windows unsupported                                                                                                                                                                       |

The live dashboard test **consumed ChatGPT Codex allowance/credits** and is excluded from default tests. Its browser observed real SDK events through SSE; native session persistence was confirmed separately from SQLite metadata. The SDK reports item-level progress, not token-level text deltas. Native model metadata is configuration evidence, not backend routing attestation.

Actual live evidence: `.ai-office/verification/dashboard-real-1792100825565/report.json`, screenshots, and application metadata in that directory. See [the full Phase 1.2 report](PHASE_1_2_DASHBOARD.md) for implementation, limitations, and earlier attempts. Two earlier live attempts are disclosed there: one found interim messages mislabeled as final; another found shutdown hanging on browser connections. Both issues were fixed and the full flow passed on rerun. The earlier port-4310 conflict was handled with ephemeral test ports; no existing user server was stopped.

The historical [Phase 1.1 SDK-only probe](PHASE_1_1_CODEX_INTEGRATION.md) passed in 17.659 s and remains separate evidence. Fixture tests are not counted as real model runs. No editing/interactive approval behavior is claimed.

No Estima or Pixel Office repository was read or modified. No production databases, automatic commits, pushes, or merges were involved.

## v0.5 Code Review Center

See [v0.5 validation evidence](V0_5_VALIDATION.md) for exact results, fixture browser reproduction, native sandbox boundaries and the reviewed [Code Review Center screenshot](design/screenshots/v05-feedback.png). No paid model call is part of deterministic validation.
