# Verification record

Current phase: **1.2**. Environment: macOS arm64, Node 24.21.0, official Codex SDK/existing CLI **0.162.1**. Local verification date: **2026-10-16** (live-run timestamp is UTC on 2026-10-15).

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
