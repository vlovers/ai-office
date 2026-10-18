# v0.6 Phase 0 — ground truth and implementation contract

Audited base: main `4589e30` (released v0.5/schema 6 plus the v0.6 roadmap).
Read ROADMAP, implementation prompt, README, architecture, lifecycle, security model,
v0.5 audit/validation, actual Store/manager/API/SDK worker/auth, Git/worktree/lease/review
code, scene/layout/UI, test fixtures and CI before choosing these boundaries.

## Identity and persistence map

| Surface                                | Current assumption / migration requirement                                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared/types.ts                        | AgentId is the two-literal AGENT_IDS union. Keep legacy IDs permanently; new IDs are server-generated UUIDs. Names never become keys/paths.                                                                                                                                   |
| Store                                  | Schema 6 tables: repositories, tasks, sessions, session_bindings, task_queue, workspaces, review_records, events. Task/session/queue ownership is in typed JSON, not SQL agent FKs. Add registry references without rewriting historical IDs.                                 |
| TaskManager constructor/dashboard/pump | One independent provider per fixed ID, two active-map keys, per-agent FIFO. Separate profiles from worker capacity, preserve per-profile serialization, select oldest eligible queue head across profiles. Blocked leases/auth must not consume all other profiles' progress. |
| index.ts / workers                     | Two private worker homes. Keep legacy paths; UUID homes are server-derived. Lazily allocate provider instances per profile, at most two active/preparing turns globally. Never derive an executable or config override from profile text.                                     |
| session/auth binding                   | Repository, provider, agent, execution mode, workspace, auth context, runtime and model must match. Add immutable config identity; profile edits cannot mutate native session config. Missing transcript/binding remains a failure.                                           |
| worktree/review                        | Base/branch/root/fingerprints and common/per-worktree leases remain authoritative. Request Changes creates an ordinary queue task with pinned revision/session, preserves history and duplicate semantics. Keep/Reject remain unchanged.                                      |
| SSE                                    | Persisted task-scoped events and cursor replay already independent of slot count. Retain task IDs and ownership; never route by editable names.                                                                                                                               |
| scene/UI                               | office-layout.ts fixes two agent IDs; pixel-art renders only those; scene-state/main default to codex-1 and assume nonempty agents. Keep two physical desks as runtime capacity visualization, add a profile list/selector, and handle archived/empty selections explicitly.  |
| tests/CI                               | Existing v0.5 unit, HTTP/SSE, production browser and native macOS policy suites are gates. Synthetic schema-6 fixtures must be created independently of the future Store migration. No model calls.                                                                           |

## SDK capability matrix

Verified pinned package `@openai/codex-sdk` **0.162.1** using installed
`dist/index.d.ts` and `dist/index.js`; bundled CLI `--version` reports **0.162.1**.
No authentication inspection or inference was needed. Official reference:
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (fetched during discovery).
Pinned local declarations/transport are the version-specific authority.

| Setting                                        | Verified behavior / v0.6 contract                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model                                          | ThreadOptions.model is passed as a separate --model argument. Support a validated optional model ID. Local-login availability must pass the existing CLI metadata catalog; API-mode availability may only be known when the provider accepts the turn. No invented model list or billing fallback. |
| role/instructions                              | runStreamed accepts text; ThreadOptions has no typed system/developer-instructions field. Include profile guidance as clearly delimited task text, never claim system authority or permission enforcement.                                                                                         |
| resume/stream/cancel                           | resumeThread(threadId, options), runStreamed and AbortSignal exist. Keep exact saved native ID and binding; never replace a missing/incompatible thread.                                                                                                                                           |
| filesystem/network/approval                    | Server-owned raw configOverrides and named profile are already verified by native tests. Do not expose these or legacy sandboxMode/additionalDirectories/network flags: they could override policy.                                                                                                |
| arbitrary tool/shell allowlists, new providers | Unsupported in Agent Studio. No fake toggles, HTTP-supplied executables, plugins, MCP or config passthrough.                                                                                                                                                                                       |

## Schema and API plan

Registry migration: schema 7 adds `agent_profiles` (stable ID, revision, deterministic
creation order, JSON) and append-only `agent_versions` keyed by agent/revision. Preserve
codex-1/codex-2 as ordinary profiles. Validate every historic task/session owner; fail and
roll back ambiguous unknown IDs instead of reassigning. Keep all schema-6 rows/IDs/queue
order and auth bindings. Existing running/stopping recovery still marks interrupted;
confirmed queued work remains queued. Archive does not delete or rewrite references.

Profile fields: id, name, role, description, instructions, model|null, maximumMode,
provider='codex', revision, archived, createdAt, updatedAt, order. New profiles default to
read-only. Display names may duplicate; IDs distinguish them. Reject blank/control-laden
names, malformed IDs, oversized instructions and unknown fields. Known credential patterns
and configured secrets must be rejected before persistence; never log submitted bodies.
Instructions remain potentially sensitive user data, not a complete secret-scanning guarantee.

REST: GET/POST /api/agents; GET/POST /api/agents/:id; POST /:id/archive and /:id/duplicate.
Edits/archive/duplicate require expected revision. List returns deterministic summaries;
detail returns bounded settings. Assignment validates live registry membership. Archive
prevents new assignment/submission; already confirmed queued/running work retains its pin.
Original pending write reviews can explicitly continue their pinned session after archival;
restore the profile for a new independent task. No referenced profile is deleted.

Execution migration: schema 8 adds immutable task-submission and execution/session snapshots.
Submission captures exact profile revision/guidance/model preference/authority cap/policy and
capability versions atomically with the queue entry. After auth resolves the actual model,
record the effective execution mode/model/provider capability/policy and bind the session
before SDK execution. Corrections reuse the original effective snapshot, not the current
profile revision. UI must show both pinned and current versions when they differ.

Legacy compatibility is explicit: v0.5 queue/session behavior is reconstructed only from
saved task mode, native thread, workspace, model and verified private binding, with empty
profile guidance and a legacy policy marker. Never infer auth/model or grant new writes.
Existing authorized writes keep their historic mode; new profiles/current defaults remain
read-only. Legacy sessions missing bindings stay readable but cannot resume automatically.

## Authority and threats

Effective mode is server policy intersected with registered workspace/user confirmation and
the pinned agent preference. A profile can restrict writes, never grant them. Both initial
write and Request Changes retain explicit confirmations, roots/fingerprints, revision/base
checks, original session ownership, no escalation, minimal worker env and Git metadata denial.
Host verification stays separately operator-enabled and confirmed, outside the agent sandbox.

Threats: name/ID traversal into worker homes; configuration injection into CLI/TOML; stored
HTML/script content; stale profile updates; edited/archived profiles changing running turns;
queued snapshots silently upgraded after restart; resume into another profile/thread/auth;
unknown legacy owners; partial migration; duplicate correction submission; unfair scheduling
and double-run; secrets in config/errors/SSE. Controls are strict schemas, UUID/legacy ID
lookup, text rendering, immutable versioned records, transactions, existing leases and exact
session/config checks. No natural-language role is an executable privilege.

## Rollback and recovery cases

Use BEGIN IMMEDIATE and bump user_version only at commit. Inject failures after schema/seed
creation and prove rollback of tables, IDs and queue. Reopen twice to prove idempotence.
Compare synthetic v0.5 repositories, active/queued/finished tasks, sessions/bindings,
workspace identity, submitted comments and events before/after. Recovered active state is
the sole expected lifecycle change; do not auto-retry it. SQLite/FK checks must stay clean.

Older binaries refuse newer schemas. Downgrade uses an operator backup made with the server
stopped, never PRAGMA edits. A missing native transcript, replaced worktree, stale lease,
changed HEAD or incompatible runtime/config remains blocked for manual inspection.

## Reviewable delivery

1. This discovery contract and independently constructed v0.5 persistence fixtures.
2. Registry schema/API and transactional migration tests; existing runtime remains compatible.
3. Immutable configuration snapshots/policy caps and legacy resume compatibility.
4. Dynamic assignment, bounded scheduling/provider allocation, queue/SSE integration.
5. Agent Studio UI and profile/version-aware dashboard/scene/review integration.
6. Comprehensive security/browser/native validation, migration/release-readiness docs.

Each PR is tested and left unmerged. Dependent changes may be stacked against the prior
feature branch so each diff stays reviewable; explicitly dispatch the existing CI workflow
when its main-only pull_request filter would otherwise omit a stacked PR. No inference,
merge, tag, release or package publication is authorized by this plan.

## Registry milestone (schema 7)

The first implementation adds the registry and strict CRUD/archive/restore/duplicate API.
Profile revisions are append-only; stale writes return 409, and migration rejects unknown
legacy owners transactionally. Both seeded profiles initially prefer read-only. This PR
intentionally leaves task assignment/scheduling and SDK execution unchanged: profile settings
become executable only after immutable snapshots and dynamic scheduling land. Existing v0.5
write authorization is therefore preserved throughout the intermediate milestone.

## Execution milestone (schema 8)

`task_configurations` stores immutable submission JSON and a once-set effective execution
JSON; `session_configurations` pins the exact effective config to its native session.
Queue insertion and submission capture commit together. Session creation, private auth binding
and config commit together. The task/session pin includes profile revision, bounded guidance,
model, mode, maximumMode, policy and capability versions. Effective config becomes durable
before `executeTask`; failed preparation may retain a submission without execution.

Profile guidance is JSON-delimited task text, not a system instruction. Local models must
exist in the inspected CLI catalog. API-mode model names are syntax-validated and provider
availability is not claimed before execution. Default-model resolution is recorded from the
prepared private binding. Resumption reuses both the original configuration and private
binding, regardless of subsequent edits. It fails if either is missing/incompatible; a new
ordinary task requires an active profile, while confirmed review corrections may reuse an
archived profile's existing pin. Existing v0.5 queued work and saved sessions receive explicit
legacy pins (revision 0, empty guidance); no authentication context is invented.

## Dynamic runtime milestone

The production manager allocates independent Codex providers lazily by validated registry ID;
worker homes use legacy IDs or server-generated UUIDs, never editable names. One/two fixed
providers remain supported for deterministic fixtures and compatibility. Global capacity is
explicitly one or two, independently of saved profiles and allocated idle provider objects.
The scheduler scans queue order, considers only each profile's oldest entry and reserves
capacity synchronously before asynchronous validation. An active profile, incompatible
connection mode or busy repository head cannot bypass that profile's FIFO, while unrelated
eligible heads can proceed. Archived profiles still execute already-confirmed pinned queues.
Task creation accepts registered active opaque IDs; SSE remains task-scoped and persisted.
