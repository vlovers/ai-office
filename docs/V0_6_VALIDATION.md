# v0.6 validation and security audit (unreleased)

This report covers the Agent Studio PR stack based on main `4589e30`. No merge, tag, release,
paid inference, real login flow or authentication-store access was performed.

## Reviewable delivery and CI

| Milestone                                | PR                                                  | Implementation commit         | Validation workflow                                                                                                 |
| ---------------------------------------- | --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Discovery + independent schema-6 fixture | [#13](https://github.com/vlovers/ai-office/pull/13) | `083a799`                     | [39111888200](https://github.com/vlovers/ai-office/actions/runs/39111888200) — green                                |
| Registry/schema 7                        | [#14](https://github.com/vlovers/ai-office/pull/14) | `367af5e`                     | [39112178669](https://github.com/vlovers/ai-office/actions/runs/39112178669) — green                                |
| Configuration/schema 8                   | [#15](https://github.com/vlovers/ai-office/pull/15) | `5bd4731`                     | [39112867656](https://github.com/vlovers/ai-office/actions/runs/39112867656) — green                                |
| Dynamic scheduler                        | [#16](https://github.com/vlovers/ai-office/pull/16) | `d591626`                     | [39113049799](https://github.com/vlovers/ai-office/actions/runs/39113049799) — green                                |
| Studio/browser coverage                  | [#17](https://github.com/vlovers/ai-office/pull/17) | `b9964e8`, `8ba6058`          | [39114100818](https://github.com/vlovers/ai-office/actions/runs/39114100818) — green after delayed-registration fix |
| Final hardening/docs                     | [#18](https://github.com/vlovers/ai-office/pull/18) | `22e2e41` plus evidence links | Final workflow/checks linked in PR #18                                                                              |

PRs are stacked in dependency order to keep each diff reviewable. The existing main-only PR
workflow does not automatically check stacked targets, so the same workflow was explicitly
dispatched on each exact branch. All are left unmerged. Package version remains 0.5.0 until
an approved release preparation.

## Audit findings and fixes

1. **Identity and migration:** fixed-ID assumptions existed in the literal type, API,
   manager/provider map, queue and SVG layout. Stable registry IDs now drive assignment;
   only generated/legacy IDs reach worker paths. Schema-6 fixture tests independently
   construct legacy SQL/data and prove ownership, queue order, bindings, review feedback,
   events and restart preservation. Unknown owners/malformed metadata roll back DDL,
   recovery events and lifecycle edits. FK checks remain clean.
2. **Execution drift:** queue-time profile edits could otherwise change later execution.
   Immutable submission/effective/session pins now preserve guidance, model, mode and
   capability/policy versions. Correction tests lower the current cap, change instructions/
   model and archive the profile, then prove the original native session/config is reused.
3. **API default model:** API metadata cannot resolve a provider's unspecified default.
   New API submissions require an explicit model ID; legacy unpinned API queues fail before
   execution. No guessed default or replacement session is used. Local metadata resolves
   and pins its default; unavailable models fail without fallback.
4. **Capacity under cleanup uncertainty:** retaining only leases was insufficient to prove
   a terminated worker no longer occupied a slot. Unconfirmed cleanup now quarantines its
   reservation as well. Tests prove another submission stays queued and stop/shutdown
   report uncertainty. No automatic cleanup/retry is introduced.
5. **Untrusted config/errors:** strict schemas reject unknown fields, ID/path injection,
   control characters, oversize text, model flags, known credentials and configured keys.
   Validation replies use issue codes instead of reflecting arbitrary unknown-key text.
   Profile guidance never reaches CLI config or filesystem policy. React renders names/
   instructions as text; browser fixtures prove script-like input cannot execute.
6. **Cross-form draft reset:** UI CI found that repository registration could reset a
   separately selected task execution mode. PR #17 fixes the unrelated reset and adds a
   deterministic delayed-registration browser regression. The failing initial CI run is
   superseded by validation on the corrected head.
7. **Accessibility/persistence:** browser checks exposed and fixed modal Tab-wrap behavior.
   Initial focus, Escape, opener restoration, responsive width, duplicate names, CRUD,
   dynamic task selection, pinned resume and fresh-Store restart are exercised. Existing
   v0.5 dashboard/review browser scenarios remain required CI gates.

Review paths examined: `agents`, `app`, `store`, `execution-config`, manager start/pump/run/
stop/shutdown/review operations, auth/provider/SDK worker, workspaces/repositories/locks,
SSE, Studio/main/scene/review UI, fixtures, migrations and workflow. No user-supplied executable,
authorization root, environment, tool config or raw SDK override was added. Leases, revision/
HEAD/ownership checks, sensitive-file filtering, explicit write/correction confirmation,
private bindings and disabled-by-default host verification remain authoritative.

## Local validation

Node **24.21.0**, macOS, pinned SDK/CLI **0.162.1**, locked dependencies. Dependencies were
installed in an isolated worktree; `npm ci` reported zero vulnerabilities. All model-related
execution used a synthetic CLI transport or controlled provider and disposable repos/DBs.
The earlier shared-module-symlink run was superseded by independent dependencies; no mixed
in-progress source/test run is counted as evidence.

Final local results: **100/100 unit/integration tests in 16 files** (194.78 seconds),
**2/2 HTTP/SSE smoke tests**, all three production browser workflows, native macOS sandbox
probes, TypeScript, production build, formatting and Git whitespace checks pass. The final
full run includes the legacy API-default and configured-secret regressions. No checks were
disabled and no real inference was used. Browser workflows cover keyboard/accessibility,
interleaved SSE, queue/cancel/stop, the v0.5 correction loop, failed resume, historical
revisions, Keep/Reject, Studio CRUD/config pins and fresh-Store restart.

Required commands:

```sh
npm run typecheck
npm test
npm run test:smoke
npm run build
npm run test:browser
npm run test:browser:write
npm run test:browser:studio
npm run test:sandbox
npm run format:check
git diff --check
```

Targeted milestones passed registry/migration/Store (10 tests), final configuration/migration/
Store (11 tests before final hardening), auth/review configuration checks (32 tests), dynamic
runtime (3 scenarios) and scene rendering (4 tests). Final full-suite evidence supersedes
these overlapping targeted counts. Screenshots are reproducible with the production Studio
browser command; [desktop](design/screenshots/v06-agent-studio-desktop.png) and
[mobile](design/screenshots/v06-agent-studio-mobile.png) contain only synthetic data.

## Remaining limits

This is a single-user loopback tool. Profiles/instructions/history are plaintext metadata,
not a secret vault; rejection/redaction catches known/configured patterns, not arbitrary
secrets. Native transcripts/context remain necessary. API model IDs are validated syntax,
not provider availability; only an approved real turn could establish that. No v0.6 real
inference was authorized. Native sandbox validation is macOS-specific; Linux remains
unverified. Deny globs, OS/runtime bugs, external editors, detached descendants, host crashes
and opt-in arbitrary host verification retain existing limits. No guaranteed isolation,
backup, retention, encrypted export, history filesystem snapshot or automatic recovery is
claimed. See [security](SECURITY.md) and [workflow/migration](V0_6_AGENT_STUDIO.md).
