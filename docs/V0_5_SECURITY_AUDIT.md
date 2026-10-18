# v0.5 focused security and reliability audit

Scope: PR #9 on `feat/v05-code-review-center`, compared with main
`6a735351db43b70471ffcf857f0bed800c35afcc`. The pushed implementation and its existing
focus fix at `86fcaff` were reviewed, followed by the confirmed fixes below. This continues
the existing milestone; it introduces no replacement service, queue, worker or SDK adapter.

Reviewed the complete v0.5 diff: HTTP contracts, manager/queue lifecycle, SQLite schema 6,
Git review generation, shared types/parser, React review component/styles, dashboard focus,
fixture/browser/store tests, package metadata and workflow/security/architecture documents.
Also traced the unchanged authorization, Git hardening, lease, authentication binding,
Codex worker and process-cleanup primitives used by the new paths.

## Confirmed findings and fixes

| ID / severity                     | Reproduction and impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fix and regression evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V05-01 / Medium, recovery         | Confirm Request Changes, cancel before queue execution, then open the canceled task's review. Cancellation did not advance the generation; an unexecuted task could also supersede the original session in the latest-task check. After advancing the generation, opening the canceled task first reproduced `This review has no resumable session`: its execution session had never been attached. Saved history/files remained intact, but the ordinary feedback loop could not retry. | Queue removal, stopped state and generation now commit together. Never-executed tasks do not supersede executed session identity. Review capture uses only the correction's explicitly pinned original session/thread when it has no execution session; no workspace-session search or replacement thread is inferred. Regression cancels, opens that canceled task, preserves original session/thread, rejects replay as another turn, and executes only after new feedback plus a fresh confirmation. An injected SQLite workspace-update failure verifies rollback of queue/state before successful cancellation. |
| V05-02 / Medium, unsaved feedback | Inject one HTTP 409 during draft save. The draft remains local, but the error's Retry review button stayed enabled. Retrying against a changed Git revision would trigger revision-state reset and discard that local feedback without the explicit discard action. The browser regression first failed because Retry was enabled.                                                                                                                                                       | Retry is disabled while local text/comments are unsaved, matching the ordinary refresh/history guards. The existing explicit discard-and-reload action retains its confirmation. Browser regression checks local feedback survives the save failure and canceling discard, then can be saved normally.                                                                                                                                                                                                                                                                                                               |

The previously pushed workstation focus fix was retained. Its deterministic same-frame
regression verifies that a deferred inspector jump cannot steal focus after the user moves
to another control; the original keyboard assertion was not removed or relaxed.

## Security invariants traced and tested

- **Request Changes:** strict UUID/revision/version/explicit-confirmation JSON; only persisted
  feedback is submitted. Workspace/revision identifies one immutable submission. Task,
  existing FIFO entry and submitted history commit together. Duplicates return that original
  task and do not authorize another turn. Concurrent submissions fail busy or resolve to the
  accepted task. Fresh feedback uses optimistic draft versions.
- **Ownership and stale execution:** existing common/worktree leases, canonical authorized
  roots, source/common metadata fingerprints, pending decision, expected branch and base are
  reused. Revision and the current SQLite session/binding are checked after asynchronous
  authentication and before executeTask. Tests mutate files and session identity during
  preparation and verify zero write-turn executions. Existing replacement/advanced-HEAD,
  sensitive-path, ignored/nested-file and literal-pathspec tests remain enabled.
- **SDK resume:** continuation pins repository, original agent/provider, execution/auth mode,
  saved session and native thread. The worker calls the pinned SDK's resumeThread; there is
  no new-thread fallback. Different resumed thread events cause failure and supervised stop.
  Native transcript absence/incompatibility is not repaired or guessed. Queue cancellation
  retains only already-authorized source identity; a retry still needs new confirmation and
  all normal validation. The queue's existing confirmed-restart authorization is unchanged.
- **Schema 6:** WAL, foreign keys and BEGIN IMMEDIATE migration/operations retain the v0.4
  model. Workspace/revision primary key and workspace-local sequence are unique. Migration
  preserves tasks, queues and private bindings without guessing auth or enabling writes;
  older binaries refuse the newer version. Submission and cancellation failure injections
  verify rollback. Active turns recover as interrupted without automatic retry. Review rows
  survive Keep/Reject because filesystem cleanup does not delete workspace/history metadata.
- **History and anchors:** bounded stored patches are independent of live filesystem reads.
  Comments reference only their original revision and literal persisted file/line. Older
  anchors are labeled outdated rather than relocated. Submitted feedback stays immutable;
  historical mode has no write/decision controls. Verification is attributed to its input
  revision, and later revisions label it as earlier.
- **Untrusted content and bounds:** diffs, names and comments render as React text; no unsafe
  HTML, eval, content execution or source-controlled executable is added. Git retains literal
  pathspecs and disabled hooks/filters/external diff/textconv. Canonical no-follow reads and
  existing ownership checks remain. Sensitive, binary, oversized and unavailable findings
  remain visible. Patch, feedback, row-rendering and history-page limits are documented.
- **Verification and data preservation:** host verification remains disabled by default and
  separately confirmed when configured. It retains full host permissions as an explicit
  trust boundary. Keep preserves the branch/files; Reject retains the existing ownership,
  HEAD, ignored-file and nested-repository protections. No auto commit/push/merge, primary
  checkout modification or branch deletion is added.

## UI, restart and documentation checks

Production-browser coverage exercises file/line navigation, accessible line/comment labels,
comment edit/removal, persisted saves, save-conflict recovery, modal focus/cancel/confirmation,
corrected revisions, failure history, historical anchors, verification attribution, responsive
320–1440 px layouts and both Keep/Reject after feedback. It asserts no page errors and an
unchanged primary checkout.

The restart case now recreates SQLite, manager, auth and both providers, retaining only disk
metadata and fixture inspection inputs. The browser then requests another correction through
the saved write session and verifies that no replacement session is created. This is an
application-service restart in the test driver, not a claim of recovery from every OS crash.
The existing HTTP/SSE and runtime suites separately exercise replay, recovery, worker cleanup
and process boundaries.

README, architecture, lifecycle, threat model and workflow were compared with routes/types,
rendered controls and actual persistence. Documented bounds, conservative rename display,
unified-only view, basic highlighting, explicit draft saving, queue restart semantics,
historical patch limits and default-disabled host verification match implementation. No full
filesystem snapshots, arbitrary-command safety, complete isolation or guaranteed native
session recovery are claimed.

## Residual limits and readiness evidence

No additional confirmed privilege-escalation, injection or persisted-data-loss defect was
found within this focused scope. This is not a guarantee that no vulnerability exists.
External editors remain outside app leases; Git revisions are bounded metadata observations.
Native transcripts may be unavailable. Unsaved local text must be saved before leaving or
switching tasks. History has no quota/encryption/backup facility. The UI has automated keyboard
and layout coverage, not a complete assistive-technology audit. Native filesystem validation
is macOS-specific; arbitrary host verification remains outside the Codex sandbox.

No real inference, paid model call, credential-store access, merge, tag or release is part of
this audit. All regression repositories/databases and SDK transport responses are disposable
fixtures. See [final validation evidence](V0_5_VALIDATION.md) and PR #9's checks for commands,
results, exact reviewed head and the final readiness recommendation.
