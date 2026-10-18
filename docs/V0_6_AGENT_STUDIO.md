# Agent Studio — v0.6 release candidate (not tagged)

Agent Studio extends the existing dashboard, queue, Codex worker and Code Review Center.
It supports Codex SDK/CLI **0.162.1**. It does not introduce an agent team service.
See [discovery/capability decisions](V0_6_PHASE_0.md) and [validation](V0_6_VALIDATION.md).

## Profiles and tasks

Open **Agent Studio**, then **Create agent**. Set a name, descriptive role, optional
instructions/description and optional model ID. Names can duplicate; immutable UUIDs
identify profiles. Codex 01/02 retain `codex-1`/`codex-2`. Cards support filtering,
edit, duplicate, archive and restore. Archive retains the identity and every referenced
record. A duplicate starts at revision 1 with a different identity and the same settings.

All initial profiles prefer **read-only**. To submit an isolated write, change the maximum
access preference to writes, configure the existing operator-authorized roots, select
write mode for the task and explicitly confirm Start. The preference only restricts
existing server authority. It cannot authorize arbitrary files, host commands or network.

Role and instructions are JSON-delimited **task text**, not SDK system instructions or
security controls. Do not put secrets in profiles. Known credential patterns and the
configured server API key are rejected, but this is not a universal secret scanner.
Profiles, instructions and snapshots are local plaintext SQLite metadata.

Blank model uses the inspected local-login default, which is resolved and pinned before
execution. Local model IDs must exist in CLI metadata. API-key mode requires an explicit
model ID; its provider availability is only known when the provider accepts the turn.
There is no fallback model, session, repository, provider or billing mode. API mode remains
optional and separately billed. No real-model testing is needed to use the fixture suite.

Choose **Assign task** on a card or use the task's agent selector. Creating a task does not
execute it. Start captures the current profile revision and submits it to the existing
persistent queue. At most two turns prepare/run globally, with one turn per profile.
FIFO heads compete in queue order; a busy repository or incompatible connection cannot
let a later task from the same profile jump ahead. Saved profile count is independent of
worker count. The two office desks follow active/selected profiles; Studio lists the rest.

## Local API contract

The existing loopback Host/Origin/JSON restrictions apply. `GET /api/agents` lists ordered
profiles; `GET /api/agents/:id` reads one. `POST /api/agents` accepts name/role plus optional
description/instructions/model/maximumMode (defaults: empty text, null model, read-only).
`POST /api/agents/:id` replaces settings using the same fields and required current
`revision`; send all settings when editing, since omitted optional fields reset to defaults.
`POST /api/agents/:id/archive` takes `{ revision, archived }`; duplicate takes `{ revision }`
at `/api/agents/:id/duplicate`. Stale revisions return 409; unexpected fields return 400.
IDs, provider, timestamps, ordering and next revision are always server-owned. There is no
HTTP delete or arbitrary SDK option endpoint. Task assignment accepts an active registry ID.

## Edits, sessions and review

Edits create append-only profile revisions. They affect later independent submissions,
not submitted/running tasks or saved sessions. Task workspace details show the pinned
configuration and the current profile revision separately. Selecting a saved session
reuses its original pin, including model, guidance, mode and policy version. An ordinary
new submission requires an active profile; restore an archived profile before new work.

The Code Review Center retains file navigation, bounded unified diffs, draft feedback,
revision-pinned anchors/history and Keep/Reject. **Request Changes** shows the exact task,
worktree, native session, feedback and pinned configuration before confirmation. Corrections
can continue an archived profile's existing authorized write session. They do not apply
profile edits. Stale revisions, changed ownership/HEAD/session/auth context, missing pins or
unsupported runtime fail closed. Duplicate revision submissions retain their original task.
There is no replacement thread. Host verification stays disabled unless separately enabled
by the operator and confirmed by the developer.

Historical review records identify the original configuration and persisted patch; they
are not filesystem snapshots. A pre-v0.6 record may show a migrated **legacy v0.5** pin,
which explicitly records the absence of historic profile guidance. The original private
auth binding/native transcript is still required. A saved API session with no explicit
model cannot safely resume: inspect it manually and create an explicitly configured task.
This does not rewrite the old session or discard its history/worktree.

## Migration and recovery

Stop the server and take an operator-managed backup of the data directory before upgrade.
No automatic backup, retention or encryption is provided. Never copy a live SQLite database
without its WAL/SQLite backup semantics. Keep the original native CLI transcript/context.

Schema **7** creates profiles and append-only versions; schema **8** adds task submission/
effective execution and session configuration tables. The migration is one BEGIN IMMEDIATE
transaction, preserving existing task/session IDs, owners, queue ordering, private bindings,
workspace identity, events and review records. Codex 01/02 become editable read-only default
profiles. Already-confirmed v0.5 write queues/sessions retain explicit legacy write pins;
new writes require opting into the current profile preference. Unknown legacy owners or
malformed metadata roll the migration back instead of being reassigned.

Running/stopping tasks recover as interrupted. Confirmed queues remain submitted and can
run after listen; they keep their saved configuration even after archival. Missing model/
auth context, native transcripts, advanced branches, replaced worktrees, stale leases and
ambiguous operations require manual inspection. A worker with unconfirmed process cleanup
keeps its capacity reservation and leases; stop/shutdown report uncertainty. Do not clear
locks or restart to evade that diagnostic. Inspect remaining processes/resources first.

Older binaries reject schema 8. Downgrade requires restoring a stopped-server backup, not
editing user_version. No app path automatically commits, pushes, merges, releases, deletes
branches or adopts unrelated files. Read [workspace recovery](WORKSPACE_RECOVERY.md).

## Supported UI and limits

Native labeled controls, keyboard navigation, focus-wrapped dialogs, Escape/cancel, focus
restoration, dark theme, reduced-motion preferences and small screens are covered in
Chromium fixtures. Studio accepts bounded text (name 80, role 160, description 2,000,
instructions 12,000 UTF-16 units, model ID 100); the API also has a 24 KiB JSON body limit.
Close/reopen a conflicting edit to load the latest revision; drafts are not autosaved.

No arbitrary filesystem/shell/tool/network configuration, system prompt API, provider
plugins, multi-user collaboration, encrypted configuration export, unlimited workers,
Linux native sandbox guarantee or guaranteed crash recovery is offered. Model inference
and arbitrary host verification were not exercised for this milestone. Existing sensitive
file filtering, external-edit races and OS/runtime limitations remain documented in
[security](SECURITY.md).
