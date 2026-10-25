## Objective

Describe the user-visible outcome.

## Related issue

Link the issue, if one exists.

## Scope

- Included:
- Excluded:

## Acceptance criteria

- [ ] Requirements implemented
- [ ] No blocking findings
- [ ] Documentation updated

## Verification

Record exact base/head SHA, CI run links, actual results and the environment.
If the target branch moved, describe reconciliation and revalidation.
For N/A checks, state why; never replace a failed check with N/A.

- Formatting:
- TypeScript:
- Tests:
- Build:
- Browser and workflow tests (including `test:browser:office` if relevant):
- Native sandbox / authorized real Codex evidence (or explicit unverified):
- Delivery security / TLS / GitHub permission evidence (if in scope; otherwise N/A):

## Product boundary

- [ ] Local dashboard/Vite/task-SSE ingress stays loopback-only.
- [ ] Delivery ingress is separate; remote Git writes remain disabled unless separately reviewed and authorized.
- [ ] Tagged release, main integration and PR-head verification are described distinctly.

## Risks

- Compatibility:
- Permissions and data safety:
- Release impact:
- Rollback plan:

## Independent review

- Reviewed base SHA / head SHA:
- Authorized reviewer and approval status (AI review is not GitHub approval):
- Reviewer:
- Findings:
- Resolutions:
- Remaining blockers:

## Release

Release approval is separate from PR approval.
