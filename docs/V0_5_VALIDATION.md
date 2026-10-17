# v0.5 validation evidence

Validated on macOS / Node **24.21.0**, based on main
`6a735351db43b70471ffcf857f0bed800c35afcc` (tagged v0.4.0).
The branch uses the unchanged pinned Codex SDK 0.162.1; no new dependencies.
All repositories, databases, tasks and feedback used below are disposable fixtures.
No paid model call, real inference, authentication-store read, commit/push/merge by AI Office's
Codex workers, branch deletion or package publication was performed during validation.

| Command                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                       | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm test`                                | **86 tests, 12 files passed**, 173.78 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm test -- tests/review-center.test.ts` | **11 review-loop tests passed**, 71.92 seconds, including session identity replacement during asynchronous auth. Also included in the final full suite.                                                                                                                                                                                                                                                                                                           |
| `npm run test:smoke`                      | **2 HTTP/SSE tests passed**, 6.59 seconds; real SDK with fixture CLI, persistent replay/restart/resume.                                                                                                                                                                                                                                                                                                                                                           |
| `npm run build`                           | Passed server compilation and production Vite build. No new runtime/UI dependencies.                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run format:check`                    | Passed Prettier.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run test:sandbox`                    | Passed credential-free native read-only and isolated-write policy checks on macOS.                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run test:browser`                    | Passed production two-agent dashboard, queue/SSE, cancellation, keyboard navigation, responsive 320–1440 px, reduced motion, auth selection and saved-session fixture resume; no page errors.                                                                                                                                                                                                                                                                     |
| `npm run test:browser:write`              | Passed production Code Review Center: keyboard file/line navigation, diff selection, draft edits/removal/reload, cancel/focus restoration, exact-target confirmation, feedback submission, same-thread corrections, new revisions, outdated history, sanitized failed resume, full backend/SQLite restart, verification attribution, responsive widths and Keep/Reject after feedback. Preserved rejected history and unchanged primary checkout; no page errors. |
| `git diff --check`                        | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `git merge-base HEAD origin/main`         | Matches the base above after fetching main; no unrelated local changes at audit start.                                                                                                                                                                                                                                                                                                                                                                            |

The native probe verifies repository reads, denial of outside/secret/other-worktree reads,
read-only writes denied, isolated worktree writes allowed, sibling/secret/nested metadata
and symlink escapes denied, linked-worktree Git-pointer removal/rename denied, and primary
checkout access denied. This is evidence for the tested macOS runtime and policy, not a
complete isolation claim or verification of arbitrary host commands. Linux native policy
is not locally verified; CI retains the existing macOS native job.

New backend tests cover persisted draft edits and conflicts, invalid literal paths/anchors,
stale revisions before and after submission, session identity changes including during auth,
exact-thread reuse, atomic task/queue/history rollback under an injected SQLite failure,
concurrent/duplicate submissions, sensitive/binary/oversized findings, explicit HTTP
confirmation, stop followed by Keep, rejection with retained history, and schema-5 migration.
Existing v0.4 suites retain worktree replacement, branch/base advancement, filter/pathspec
injection, ignored/nested user-data preservation, timeout/cancellation, recovery and
unauthorized-write coverage. No test was disabled for this milestone.

## Reproduce visual and workflow evidence

Use Node 24.x (the local shell initially selected Node 20, which cannot run node:sqlite).
Install dependencies and Chromium, then run from a normal terminal with functioning
loopback/browser/native-sandbox access:

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run test:smoke
npm run build
npm run test:browser
npm run test:browser:write
npm run test:sandbox
npm run format:check
git diff --check
```

If Chromium uses another cache, set `PLAYWRIGHT_BROWSERS_PATH` accordingly; local validation
used `/private/tmp/ai-office-playwright`. Set `AI_OFFICE_SCREENSHOT_DIR` to an existing
writable directory. The browser test captures `ai-office-v05-feedback.png`,
`ai-office-v05-mobile.png` and `ai-office-v05-review.png`. The intentionally selected,
visually inspected [feedback screenshot](design/screenshots/v05-feedback.png) shows the
real production component with synthetic fixture feedback/thread identity and no personal
repository paths or credentials. It is a bounded patch review, not real-model evidence.

GitHub Actions runs the same deterministic tests/build/browser checks on Ubuntu and the
native probe on macOS. The PR's checks and final delivery report identify its exact run and
commit; local results above do not substitute for CI. Real-model testing was not requested
or approved and was not executed.

## Remaining limits

Unified view only; basic safe keyword highlighting; conservative delete/add rename display;
bounded patches and no historical filesystem snapshots. Unsaved local text needs explicit
staging/saving before leaving or switching tasks. Saved/submitted feedback is persisted.
Native transcript loss or incompatible SDK/auth context can block continuation; no replacement
thread or guaranteed recovery is offered. External editors can race metadata observations.
Host verification is disabled by default and, when explicitly enabled, runs with full host
permissions. Review history has no retention quota/encryption. Automated keyboard/layout
checks are not a full assistive-technology audit. See [workflow](V0_5_REVIEW_CENTER.md) and
[threat model](V0_5_SECURITY.md) for the precise boundaries.
