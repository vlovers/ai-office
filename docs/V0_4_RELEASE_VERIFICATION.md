# v0.4.0 release preparation — 2026-10-18

**Recommendation: READY for an initial experimental macOS release within the documented single-user security model.** All planned release gates passed, including the explicitly approved real-model workflow. Linux native isolation remains unverified. No GitHub Release, tag or package publication has been performed.

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

## Real-model gate — passed after explicit approval

**Two real `gpt-6.1-sol` turns completed successfully**, using existing ChatGPT CLI authentication, SDK/CLI 0.162.1 and the unchanged native permission profile. No API key, fallback, retry or additional model turn was used. Authentication/model metadata requests are separate from inference.

Prepared disposable fixture (no inference):

```text
/private/var/folders/qj/0vq3nqvn1l17pj0s6lxzf6s40000gn/T/ai-office-real-write-SGcc0A/repository
```

Exact approved and executed command (exit 0):

```sh
npm run test:real:write -- --run --root /private/var/folders/qj/0vq3nqvn1l17pj0s6lxzf6s40000gn/T/ai-office-real-write-SGcc0A --model gpt-6.1-sol
```

Both prompts asked only for `hello.txt` containing `hello\n`, without committing. The harness used a 120-second task bound. SDK `turn.completed` usage was recorded in the retained `evidence.json`:

| Task           | Input tokens | Cached input tokens (included in input) | Output tokens |
| -------------- | -----------: | --------------------------------------: | ------------: |
| Keep fixture   |       28,706 |                                  18,560 |            76 |
| Reject fixture |       29,013 |                                  23,936 |            77 |
| Total          |   **57,719** |                              **42,496** |       **153** |

Both turns reported zero cache-write input and reasoning-output tokens. ChatGPT allowance/credit or monetary cost was not reported by the SDK; token counts are not a price estimate.

Observed assertions passed: unconfirmed starts were refused; each isolated worktree contained `hello.txt` with the exact requested content; Git-derived file lists/diffs and dedicated branches were verified; primary status, HEAD and README remained unchanged. A separate process reopened the database and reviewed both pending workspaces. The fixed absolute-Node file-content check passed (`Fixture verified`), using the approved host permissions and 10-second timeout. Keep preserved one worktree. Reject removed only the other worktree, retaining its dedicated branch. A third process verified persisted decisions, native thread identifiers, recorded SDK usage and the kept verification result.

A supplemental no-inference inspection reopened the same database in the production-built HTTP application. Health, served frontend, existing ChatGPT connection, both persisted sessions, empty queue, kept/rejected review endpoints, readable `+hello` Git diff and the persisted passing verification all passed. Additional inference was explicitly blocked in that inspection. Output is retained in `persisted-http-evidence.json` beside the E2E evidence. Independent Git inspection confirmed only the primary and kept worktree remain registered.

No unknown resources or branches were deleted, and no repository outside the fixture was used. Evidence, SQLite metadata and the kept worktree remain available under the fixture root; they are temporary local artifacts, not committed credentials or runtime transcripts. A one-shot run claim prevents accidental additional inference; do not rerun this completed fixture.

This is a real production SDK/provider/manager/store/workspace integration probe with backend process restarts and a supplemental production HTTP reopen. It does not constitute a real-model browser test or abrupt-kill real-model recovery test. Browser paths and interrupted-worker recovery are covered separately by deterministic tests. No product regression was found, and no runtime security setting needed relaxing.

## Remaining boundaries

Single-user trusted workstation; not a multi-tenant service. Linux native sandbox remains unverified. Known-sensitive-path filtering is not a universal secret detector; native glob policies have platform/depth/timing limits. Review revisions do not create atomic snapshots against external editors. Host verification is unsandboxed and disabled by default. Detached programs can escape process groups. Stale leases and ambiguous worktree ownership require manual diagnosis, with no destructive auto-recovery. See [security model](SECURITY.md), [recovery](WORKSPACE_RECOVERY.md), and [release notes](releases/v0.4.0.md).

The merged baseline passed [Linux checks](https://github.com/vlovers/ai-office/actions/runs/39073338009/job/117515315180) and [macOS native policy](https://github.com/vlovers/ai-office/actions/runs/39073338009/job/117515315052). Release-preparation [PR #8](https://github.com/vlovers/ai-office/pull/8) passed [Linux checks including both browser workflows](https://github.com/vlovers/ai-office/actions/runs/39074060416/job/117517451869) (1m52s) and [macOS native sandbox](https://github.com/vlovers/ai-office/actions/runs/39074060416/job/117517451682) (19s) at `a92f98f`. The real-model result adds documentation only; final-head CI is tracked in the PR. Queued checks are not counted as a pass. Historical security-audit results remain in [VERIFICATION.md](VERIFICATION.md).
