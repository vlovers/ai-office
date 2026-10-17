# Security policy

AI Office is an experimental local-first, read-only coding-agent dashboard. It has **not** been independently audited. It is intended for single-user use on a trusted machine; never expose its HTTP port to a public network, tunnel or reverse proxy.

## Report a vulnerability

Use GitHub's **Report a vulnerability** / private vulnerability reporting feature for this repository if available. If it is unavailable, contact the maintainer through a private channel listed on their GitHub profile. **Do not publish exploit details, credentials, private repository content or live-session tokens in a public issue.** No fixed response or disclosure timeline is promised.

Include a concise reproduction, affected version/commit, expected versus actual permission boundary, and a minimal sanitized proof of concept. Avoid testing against others' systems.

## Supported scope

Security fixes target the latest `main` branch. Older commits and unreleased experimental branches are not supported. The current threat model and recovery limitations are documented in [docs/SECURITY.md](docs/SECURITY.md).

This policy is not a security guarantee. Filesystem sandboxing is not a VM boundary; do not register repositories containing credentials, and never give an agent access to production secrets.

For opt-in isolated write sessions and trusted local verification boundaries, see [the v0.4 security model](docs/SECURITY.md).
