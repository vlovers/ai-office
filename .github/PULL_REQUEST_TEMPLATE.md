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

## Revision-bound evidence

- Base SHA / head SHA:
- CI run for the exact head:
- Branch divergence and reconciliation:
- Native sandbox / authorized real-Codex evidence (or explicitly unverified):
- Delivery HTTPS, live grants, CSRF, credentials and remote-write evidence (or N/A):
- Reviewer identity and reviewed SHA:
- Unresolved findings / follow-up:

The local dashboard must remain loopback-only. Delivery activation is a separate gate; a merged PR or reserved intent does not authorize remote Git writes. Release approval is separate from PR approval.
