# v0.5 implementation plan

Audit: main at 6a73535, v0.4 schema 5. Read README, architecture, security audit/model,
session lifecycle, workspace and repository validation, Store, manager, worker/provider,
HTTP/SSE, PHOSPHOR UI and deterministic/browser fixtures before implementation.

Reuse: Git literal pathspecs/filter suppression, bounded no-follow reads, ownership
fingerprints, revision hashes, common/worktree leases, two-slot FIFO, auth bindings,
official pinned SDK resumeThread/runStreamed and supervised process cleanup.
Keep/Reject and opt-in host verification remain the existing operations.

Gaps and implementation sequence:

1. Preserve bounded per-file Git patches and explicit withheld/binary/oversized states;
   parse unified hunks as text with deterministic old/new line anchors.
2. Transactional schema 6: immutable bounded review records, revision-bound draft
   comments and immutable submitted feedback. Preserve history after workspace rejection.
3. Request Changes under the existing review leases: validate fresh revision and exact
   session/workspace, atomically create a continuation task in the existing queue with
   feedback/history. Recheck revision and session after auth, immediately before execution.
   One submission per reviewed revision makes retries deterministic. Never replace a thread.
4. Dedicated PHOSPHOR review component: filtered explorer, bounded line rendering,
   hunk navigation, general/file/line comments, accessible native confirmation dialog,
   historical patches clearly distinguished from live state and continuation progress.
5. Disposable Git/SQLite/SDK fixture tests for stale/duplicate/concurrent operations,
   migration/restart/history, unsafe content and browser keyboard workflow. Run existing
   native sandbox, HTTP/SSE, build, formatting and Git safety checks. No paid calls.
6. Update workflow/security/lifecycle/migration/validation docs, coherent commits,
   normal push and PR against main; wait for Actions and fix genuine failures.

Scope choices: unified view first; no extra UI/runtime dependency. Rename detection stays
Git's conservative no-renames base comparison (delete/add), with raw status when available.
Persisted patches are bounded review artifacts, never filesystem snapshots. Anchors belong
only to their exact revision; previous revision anchors are always labeled outdated.
External editors are outside app leases; revision checks detect observed changes, not an
atomic filesystem lock. Verification remains disabled by default and results need explicit
revision attribution. SDK resume failure is surfaced, with no startThread fallback.
