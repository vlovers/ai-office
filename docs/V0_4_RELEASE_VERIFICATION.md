# v0.4.0 release preparation — 2026-10-18

**Recommendation: NOT READY for release until the approved real-model workflow executes successfully.** No GitHub Release, tag or package publication has been performed.

## Baseline and compatibility

Local `main` was fast-forwarded non-destructively to `4bea810` (merged PR #7); checkout was clean before creating `chore/v0.4.0-release-readiness`. The Git commit is a merge commit. Tests use disposable repositories/databases outside the AI Office checkout.

Environment: macOS arm64, Node **24.21.0**. Installed SDK **0.162.1** and npm-selected CLI **0.162.1** match the application's exact runtime allowlist. The interactive shell selects CLI **0.163.0**; direct launches with that PATH fail closed. No version check or native restriction was relaxed. Metadata-only `npm run codex:inspect` confirmed existing ChatGPT authentication and default model **gpt-6.1-sol**. It did not perform inference or print credentials.

The project uses semantic-version labels; package/lockfile were at 0.3.0, with no Git tags or GitHub releases observed. Both package versions are prepared as 0.4.0, `private: true` retained. This is preparation, not a published version announcement.

## Actual local checks

| Check                                          | Result                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                     | Passed                                                                                                                                             |
| Complete unit/integration and Git safety suite | 74/74 passed, 11 files, 103.76 seconds (includes new guard test)                                                                                   |
| New opt-in harness guard test                  | 1/1 passed; no model required                                                                                                                      |
| HTTP/SSE smoke                                 | 2/2 passed, 6.99 seconds                                                                                                                           |
| Native installed-CLI sandbox                   | Passed both permission profiles, primary checkout/Git-pointer protection, sensitive/nested paths, siblings and symlink escape probes; no inference |
| Read-only/session browser workflow             | Passed, including independent agents, queue, SSE, stop/resume/failure, keyboard, motion preferences and 320–1440px widths                          |
| Write browser workflow                         | Passed confirmation, real Git review, bounded fixture verification/persistence, keyboard focus, responsive layout, Reject and primary preservation |
| Production build                               | Passed server TypeScript and Vite frontend                                                                                                         |
| Formatting / Git whitespace                    | Passed; no separate lint script exists                                                                                                             |

The initial combined `npm run check` completed 73 unit/integration tests but failed both HTTP smoke tests with outer-sandbox `listen EPERM`. The unchanged HTTP suite passed outside that boundary. The native probe, metadata inspection and browsers also require running outside the outer tool sandbox. The application sandbox remains active. This environment failure is not counted as a passing combined command.

## Real-model gate — awaiting explicit approval

**No model turns executed; no model tokens consumed by this release validation.** Authentication/model metadata requests are separate from inference.

Prepared disposable fixture (no inference):

```text
/private/var/folders/qj/0vq3nqvn1l17pj0s6lxzf6s40000gn/T/ai-office-real-write-SGcc0A/repository
```

Exact proposed command:

```sh
npm run test:real:write -- --run --root /private/var/folders/qj/0vq3nqvn1l17pj0s6lxzf6s40000gn/T/ai-office-real-write-SGcc0A --model gpt-6.1-sol
```

The opt-in command plans **two model turns**, existing ChatGPT allowance/credits only, no API-key fallback or automatic retries. Each prompt asks only for `hello.txt` containing `hello\n`, without committing. Each task has a 120-second bound. Exact token/credit cost cannot be predicted; recorded SDK `turn.completed` usage will be preserved in `evidence.json`.

The harness checks refused unconfirmed starts, isolated writes, unchanged primary status/HEAD/content, real Git file/diff/branch data and persistent sessions. A separate process reopens the database, reviews both pending workspaces, runs a fixed absolute-Node file-content check with a 10-second timeout and full host permissions, then Keeps one and Rejects the other. Another process verifies both persisted decisions and the kept verification result. Reject must preserve the dedicated branch. No unknown resources are removed, and no repository outside the fixture is used. Evidence, SQLite metadata and the kept worktree are retained even on success. A one-shot run claim prevents accidental additional inference; failed runs require inspection and a newly approved fixture rather than retries.

This is a production SDK/provider/manager/store/workspace integration probe. It does not substitute a real-model browser test or an abrupt-kill recovery test. HTTP/browser paths and interrupted-worker recovery are covered separately by deterministic tests. Do not describe planned assertions as observed real-model outcomes.

## Remaining boundaries

Single-user trusted workstation; not a multi-tenant service. Linux native sandbox remains unverified. Known-sensitive-path filtering is not a universal secret detector; native glob policies have platform/depth/timing limits. Review revisions do not create atomic snapshots against external editors. Host verification is unsandboxed and disabled by default. Detached programs can escape process groups. Stale leases and ambiguous worktree ownership require manual diagnosis, with no destructive auto-recovery. See [security model](SECURITY.md), [recovery](WORKSPACE_RECOVERY.md), and [release notes](releases/v0.4.0.md).

The merged baseline passed [Linux checks](https://github.com/vlovers/ai-office/actions/runs/39073338009/job/117515315180) and [macOS native policy](https://github.com/vlovers/ai-office/actions/runs/39073338009/job/117515315052). Release-preparation CI evidence will be linked from its PR; queued checks are not a pass. Historical security-audit results remain in [VERIFICATION.md](VERIFICATION.md).
