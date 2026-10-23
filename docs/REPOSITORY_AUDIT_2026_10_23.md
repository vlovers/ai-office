# AI Office repository audit — 2026-10-23

Scope: repository `vlovers/ai-office`, `main` at `b3f7ee9a32f2f09ee5cdc2041c8049976ba3b41d`; open PRs and CI configuration inspected through GitHub. This is a **source/documentation audit**, not a fresh local build, native sandbox run, security penetration test or UI screenshot review.

## Executive assessment

AI Office is a **single-user, local-first Codex coding workspace** with substantial implemented task, session, permission, review and operator-gated workflow functionality. It is **not** an autonomous multi-agent organization, a general provider platform, a hosted SaaS or an unattended deployment service. The strongest technical vertical slice is a manually approved Codex task → isolated worktree → diff/revision review → optional Reviewer/QA checkpoints. The largest MVP risks are the unvalidated latest office UI, first-run usability, release-truth drift and incomplete real-installation acceptance evidence.

## Verified repository inventory

| Area                  | Source / evidence                                                                                                          | Finding                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime               | `package.json`, `src/server/index.ts`, `src/server/app.ts`                                                                 | Node 24, Fastify 5, React 19/Vite 8, TypeScript 7, local loopback API                                                                                      |
| Codex                 | `src/server/providers/`, `package.json`                                                                                    | Pinned official `@openai/codex-sdk@0.162.1`; local CLI login preferred; optional explicit API-key mode                                                     |
| Persistence           | `src/server/store.ts`, `docs/ARCHITECTURE.md`                                                                              | SQLite/WAL with migrated agent, task, session, review, workflow and execution records                                                                      |
| Agents and scheduling | `src/server/agents.ts`, `src/server/manager.ts`, `tests/dynamic-agents.test.ts`                                            | Persisted editable profiles; two concurrent worker slots; bounded queued submissions                                                                       |
| Isolation             | `src/server/workspaces.ts`, `src/server/providers/native-isolation.ts`, `docs/SECURITY.md`                                 | Registered repositories, explicit isolated-write approval, worktree leases, fail-closed cleanup; macOS native path verified historically                   |
| Review                | `src/web/review-center.tsx`, `src/server/repositories.ts`, `tests/review-center.test.ts`                                   | Revision-bound diffs, feedback, Request Changes, Keep/Reject; no automatic merge                                                                           |
| Workflow              | `src/server/workflows.ts`, `src/server/workflow-execution.ts`, `src/server/reviewer-runtime.ts`, `src/server/qa-runner.ts` | Coder → Reviewer → optional read-only QA with explicit checkpoints and persisted reports                                                                   |
| Web office            | `src/web/main.tsx`, `src/web/pixel-art.tsx`, `src/web/office-layout.ts`                                                    | Office V2 integrated in main; SVG two-seat scene and dynamic profile overflow, not a multi-room simulator                                                  |
| Verification          | `.github/workflows/validation.yml`, `tests/`, `docs/V0_7_VALIDATION.md`                                                    | Typecheck, unit/integration, HTTP/SSE, build, formatting, browser smoke and macOS native workflow job; historical green runs are not fresh main validation |
| Releases              | `README.md`, `CHANGELOG.md`, `ROADMAP.md`                                                                                  | v0.5.0 documented as last published release; v0.6/v0.7 integrated but untagged                                                                             |

## PR and branch reconciliation

- `main` currently points to `b3f7ee9`, incorporating Office V2 PR #27 and documentation PR #28; both were incorrectly described as pending in older documents.

- [PR #31](https://github.com/vlovers/ai-office/pull/31) is open and Draft, based on `main`. It contains the warmer Office V3 scene, roster, filters, queue preview, collapsible diagnostics and additional environment graphics. It is **not merged**.

- The most recent inspected PR #31 workflow run (run #363, ID `39890922882`) **failed Formatting**; the native filesystem policy job passed. Do not describe V3 as validated or shipped.

- Other open PRs at audit time: #30 (Vitest dependency), #29 (upload-artifact), #21 and #11 (older documentation), #6 and #5 (GitHub Actions upgrades). These require individual review for supersession, compatibility and CI; do not blindly merge or close them.

- No open non-PR GitHub issues were returned by the inspected issues listing. This does **not** mean all roadmap work is complete.

## Findings, ranked

### P0 — Release and acceptance truth

1. **Documentation drift.** `ROADMAP.md` and `docs/MVP_STABILIZATION_CHECKLIST.md` still describe PR #27/#28 as pending despite their merge. `README.md` still uses the PHOSPHOR OS heading for a scene whose current main label has evolved. Synchronize main and PR status.
2. **Office V3 quality gate is red.** PR #31 formatting failure blocks merging. Run the pinned Prettier version, full CI, desktop/mobile screenshot inspection, keyboard and reduced-motion checks on the final head.
3. **Local MVP E2E acceptance is not freshly demonstrated.** Historical v0.7 validation includes a real Coder/Reviewer and native QA trial on macOS, but it does not prove the current integrated main or V3 on an ordinary first-run installation. Capture environment, commit, authorization steps and artifacts.
4. **Release tags lag implementation.** Do not call v0.6 or v0.7 published releases; select the next tag only after acceptance, documentation and approval.

### P1 — Product and delivery gaps

5. **Visual scene remains two-seat SVG.** Dynamic profiles are represented in lists, not by unlimited visible desks. No finished game-like multi-room office or proven visual-quality bar. Prioritize one cohesive scene/UI iteration rather than accumulating CSS overrides.
6. **First-run UX needs a measured walkthrough.** Validate CLI discovery, workspace registration, profile creation, read-only task submission, review, failure recovery and permissions without terminal guesswork. UI existence is not usability evidence.
7. **No integrated GitHub PR publishing flow.** Existing Keep/Reject preserves isolated changes and leaves integration manual. Proposed delivery must use least-privilege permissions and explicit push/PR confirmation; no automatic merge.
8. **No general scheduler or autonomous agent team.** Queue dispatch after explicit submission is not recurring scheduling, dependency planning or independent agent delegation.
9. **Observability remains local/task-focused.** Improve run-level summaries, diagnostic export with redaction, actionable blocked states and recovery guidance before introducing autonomous retries.

### P1/P2 — Platform and security constraints

10. **Provider breadth is limited.** Provider-facing abstractions do not establish verified Claude/Gemini integrations. Codex is the supported provider.
11. **Native Linux success path is unverified.** Ubuntu CI running unit/browser tests does not establish Linux native Codex sandbox compatibility. macOS evidence must not be generalized.
12. **Host verification is not sandboxed.** Explicit opt-in host verification can run AI-edited scripts with user privileges. Preserve independent confirmation and keep it disabled by default.
13. **Single-user localhost trust boundary.** No multi-user authentication, tenancy or safe public hosting; no tunnel/proxy exposure. Known-pattern redaction is not a comprehensive secret scanner.
14. **Recovery is deliberately conservative.** Unknown leases, orphaned worktrees, advanced Git state and missing native transcripts require manual inspection. Do not auto-clean or silently retry.

## CI audit

`.github/workflows/validation.yml` defines:

- Ubuntu: `npm ci`, TypeScript, unit/integration, HTTP/SSE smoke, build, Prettier check, browser smoke, isolated-write browser smoke, Agent Studio browser/restart smoke.

- macOS: credential-free native filesystem policy, Reviewer/QA/workflow integration, production dashboard build, browser workflow approval journey and 7-day screenshot artifact.

- No general live-model inference in CI (intentional: usage and credentials).

- Existing workflow has no explicit `npm run test:dashboard:real` / `npm run test:real:workflow` run in normal CI (intentional; manual approval required).

- A GitHub Actions green badge does not prove current release, visual quality or Linux native policy.

## MVP acceptance scenario

1. Install on supported macOS with Node 24, Git and pinned supported Codex CLI.
2. Authenticate with existing local login; no implicit API billing.
3. Register a trusted repository; create/select a profile; create and explicitly start a read-only task.
4. Observe truthful streamed events, final result and persisted session after restart.
5. Explicitly authorize an isolated write task; confirm original checkout and Git metadata are preserved.
6. Review bounded diff, request corrections, approve or reject with revision checks.
7. Exercise Coder → Reviewer → QA gates, including denied approval, stale input, cancellation and restart.
8. Review actual desktop/mobile screenshots, accessibility, error states, native sandbox output and sanitized logs.
9. Document exact SHA/OS/CLI/SDK, all test results and unresolved limitations before release approval.

## Proposed implementation order

- **Sprint A (P0):** PR #31 formatting/CI, visual review, stale documentation and first-run acceptance.

- **Sprint B (P0):** Office Experience V4 plus task/workflow navigation and coherent status presentation, tested with real/synthetic labeled states.

- **Sprint C (P1):** Approval-gated GitHub PR preparation and publishing; CI/review status readback.

- **Sprint D (P1):** Scheduling, failure diagnostics and run observability with explicit execution authority.

- **Sprint E (P2):** Dependency-aware multi-agent orchestration, provider adapters only after SDK validation.

## Audit limitations

This audit read the GitHub repository tree, key implementation files/directories, project docs, workflow configuration and PR/CI metadata. It did **not** execute the full suite locally, audit every line of every source file, perform an independent security assessment, inspect current screenshot pixels, validate GitHub branch protection, or verify arbitrary-host Linux execution. All these are distinct follow-up gates.
