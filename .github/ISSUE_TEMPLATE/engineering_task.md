---
name: Engineering task
about: Propose a scoped engineering, maintenance or quality task
title: 'task: '
---

## Desired outcome

What user-visible or operational problem are we solving?

## Existing evidence

Link relevant files, PRs, tests and prior issues. State the exact baseline commit and what is known versus assumed. Distinguish implemented, fixture-tested, native-sandbox-verified, independently accepted, merged and released.

## Scope and non-goals

**In scope:**

**Out of scope:**

## Acceptance criteria

- [ ] A concrete behavior or artifact can be verified.
- [ ] Relevant unit, integration and end-to-end evidence is specified.
- [ ] Read-only defaults, explicit isolated-write approval, workspace/lease ownership, Reviewer/QA gates and sandbox boundaries are evaluated where relevant.
- [ ] For the separate, unreleased Delivery API: operator enrollment/session revocation, live grants, HTTPS Origin/Host and CSRF, trusted workspace registry, and GET-only remote status are evaluated where relevant.
- [ ] No HTTP commit, push, publication, merge, deployment or retry endpoint is assumed to exist; a transfer-intent reservation is not authorization to perform a remote write.
- [ ] For any proposed future Git transfer or Draft PR publication: scoped approvals, local/remote ref attestation, immutable commit identity, journal/receipt consistency, lease ownership, and interrupted or ambiguous remote-write recovery are evaluated before any activation.
- [ ] Fixture/browser CI is distinguished from native sandbox and real Codex validation; unsupported or untested hosts are named.
- [ ] Host verification remains separately opted in and never substitutes for native sandbox QA.
- [ ] Security, compatibility and rollback implications are evaluated.
- [ ] Independent reviewer findings, exact commit/CI evidence, skipped checks and unresolved risks are recorded; fixture CI is not claimed as production TLS/credential acceptance.

## Dependencies and risks

- Blocked by:
- Related PR:
- Rollback / migration / recovery:
- Required independent reviewer:
- Unverified assumptions:
