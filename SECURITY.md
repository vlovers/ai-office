# Security policy

AI Office is an experimental local-first, read-only coding-agent dashboard. It has **not** been independently audited. It is intended for single-user use on a trusted machine; never expose its HTTP port to a public network, tunnel or reverse proxy.

## Report a vulnerability

Use GitHub's **Report a vulnerability** / private vulnerability reporting feature for this repository if available. If it is unavailable, contact the maintainer through a private channel listed on their GitHub profile. **Do not publish exploit details, credentials, private repository content or live-session tokens in a public issue.** No fixed response or disclosure timeline is promised.

Include a concise reproduction, affected version/commit, expected versus actual permission boundary, and a minimal sanitized proof of concept. Avoid testing against others' systems.

## Supported scope

Security fixes target the latest `main` branch. Older commits and unreleased experimental branches are not supported. The current threat model and recovery limitations are documented in [docs/SECURITY.md](docs/SECURITY.md).

This policy is not a security guarantee. Filesystem sandboxing is not a VM boundary; do not register repositories containing credentials, and never give an agent access to production secrets.

For opt-in isolated write sessions and trusted local verification boundaries, see [the v0.4 security model](docs/SECURITY.md).

The [v0.4 audit](docs/V0_4_SECURITY_AUDIT.md) records reproduced issues and fixes. [Workspace recovery](docs/WORKSPACE_RECOVERY.md) explains fail-closed handling of interrupted operations and ownership uncertainty. Host verification is disabled by default and requires an explicit operator opt-in; enabling it grants project scripts full host permissions.

The Code Review Center adds revision-bound, explicitly confirmed continuation of existing write sessions. See the [v0.5 threat model](docs/V0_5_SECURITY.md) and [workflow limitations](docs/V0_5_REVIEW_CENTER.md). No automatic replacement thread or verification authorization is provided.

Unreleased Agent Studio threat model, migration and fixture evidence: [v0.6 audit](docs/V0_6_VALIDATION.md). Profile instructions never authorize execution privileges.

The draft v0.7 workflow uses a separately verified native read-only snapshot for Reviewer and QA. QA command approval never enables host verification. Uncertain cleanup retains leases, and restart never silently retries a workflow. See the [workflow isolation, recovery and limits](docs/V0_7_WORKFLOW_ENGINE.md).
