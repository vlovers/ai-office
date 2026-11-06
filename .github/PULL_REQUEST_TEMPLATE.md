# Pull request

## Scope

- Related issue:
- What changed and why:
- Out of scope:

## Verification

- [ ] Formatting
- [ ] Lint / typecheck
- [ ] Unit / integration tests
- [ ] Build
- [ ] Browser smoke (if applicable)
- [ ] Negative authorization / concurrency tests (if security-relevant)

Provide commands, results, and links to CI. Mark unrun checks explicitly; unchecked is not passing.

## Security and operations

- Trust boundaries / credentials / tenant isolation affected:
- Security review considerations:
- Migration, deployment, or rollback considerations:
- Documentation updated:

## Review gate

- [ ] Independent reviewer approval obtained (not self-review)
- [ ] Required CI green
- [ ] No unresolved blocking findings

Do not merge until all required gates are satisfied.

## Multi-agent integration and collision control

- Parent Issue / accountable integrator / batch owner:
- Assigned implementers and independent reviewer:
- Worktree / branch ownership ledger (paths, shared API/auth/SSE/persistence/CI contracts):
- Related, overlapping or superseded PRs and integration dependency order:
- Target branch and exact base/head SHA at handoff:
- [ ] Existing relevant Issues/PRs checked before creating new work
- [ ] Shared contracts have one active writer; no colleague branch or worktree overwritten
- [ ] Changes form one meaningful independently verifiable outcome, not artificial micro-PRs
- [ ] Integration diff checked for unrelated product changes and base divergence

See [multi-agent delivery protocol](../docs/engineering/MULTI_AGENT_WORKFLOW.md). Issue ownership is coordination, not an enforced lock.

## Evidence and artifact ledger

| Evidence / check | PASS / FAIL / QUEUED / NOT RUN / N/A / STALE / UNAVAILABLE | Exact tested SHA, command, environment, UTC time, run URL | Artifact owner, access, expiry, reproduction |
| --- | --- | --- | --- |
| Relevant static / unit / browser checks | | | |
| Native macOS sandbox or real Codex (if claimed) | | | |
| Live Delivery security / grant / CSRF (if claimed) | | | |
| Independent review of final diff | | | |

- Evidence redaction: no credentials, cookies, authorization headers, private tenant data, live grants or sensitive logs in public PRs/CI artifacts.
- Missing, expired, inaccessible or superseded-SHA artifacts are marked UNAVAILABLE or STALE, never PASS.
- [ ] Final head SHA and retained evidence rechecked after material integration or rebase
- [ ] Reviewer identity, reviewed SHA, severity and resolution of each blocking finding recorded
- [ ] Release, merge, deployment and remote Git-write authorization obtained separately; AI feedback is not GitHub approval

## Revision-bound evidence

- Base SHA / head SHA:
- CI run for the exact head:
- Branch divergence and reconciliation:
- Native sandbox / authorized real-Codex evidence (or explicitly unverified):
- Delivery HTTPS, live grants, CSRF, credentials and remote-write evidence (or N/A):
- Reviewer identity and reviewed SHA:
- Unresolved findings / follow-up:

The local dashboard must remain loopback-only. Delivery activation is a separate gate; a merged PR or reserved intent does not authorize remote Git writes. Release approval is separate from PR approval.
