# Cross-stack workflow and QA security integration — 2026-10-30

This draft integration branch combines two independently validated but previously
disjoint histories. It is **not** a production release or a merge to `main`.

## Source histories

- Workflow crash/recovery and operator gates: PR #95 → #96 → #107 → #108
  (head `42982df38b89d9e6cd108a6ed085c18f86d2ade9`).
- Native QA preflight, process supervision, denial attestation and approved
  executable pinning: PR #97 → #103 → #110
  (head `6dc3fc270d122506e31cfc5195ef02bdbe0259d7`).
- UI stale-response and checkpoint confirmation changes: PR #111 → #112 are
  **not included** in this branch. Their reconciliation with #96 remains a
  separate required integration step.

## Conflict resolution

- `tests/verification.test.ts`: retain the QA supervisor's explicit
  `incomplete` attestation tests **and** the workflow branch's delayed
  descendant-write cancellation/timeout tests. The combined tests also assert
  that interrupted verification is reported as incomplete.
- `.github/workflows/validation.yml`: retain the workflow branch's
  `main`, `test/**` and `fix/**` pull-request triggers. Both source
  branches used the same validation jobs; the QA branch only lacked the
  explanatory comment.
- All other QA changes are copied byte-for-byte from PR #110's head.
  Workflow, UI and recovery files remain byte-for-byte from PR #108's head.

## Required acceptance before any merge

1. Run TypeScript, security lint, unit/integration tests, smoke tests,
   production build and Prettier on the **combined tree**.
2. Run browser workflow/restart tests with deterministic local fixtures.
3. Run native macOS sandbox, QA approval, process supervision and workflow
   recovery integration without model-provider calls.
4. Confirm the exact integration HEAD is green in **both** CI jobs.
5. Independently review process-group lifecycle, incomplete attestation,
   approval digest revalidation and operator replay prevention.
6. Reconcile the separate UI checkpoint/stale-polling branch (#112) before
   proposing any release integration.

## Safety

No real AI provider, deployment, production write or external project mutation
is required. The regression tests use temporary directories, local processes,
synthetic commands and temporary SQLite databases.
