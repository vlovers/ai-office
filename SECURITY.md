# Security policy

AI Office is an experimental coding-agent workspace. **Read-only agent execution is the default, but explicitly authorized isolated-write sessions already exist.** It has not been independently audited, and its sandbox is not a VM or a security boundary against other processes running as the same OS user. Do not give agents production secrets or assume redaction detects arbitrary sensitive content.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** / private vulnerability reporting feature for this repository **if enabled**. If it is unavailable, contact the maintainer through an independently verified private channel listed on their GitHub profile. If no safe private channel is available, do not publish exploit details while seeking one. A public Issue, PR, discussion or screenshot is **not** a confidential disclosure channel.

Include the affected release or exact commit, the expected and observed permission boundary, a minimal sanitized reproduction using disposable data, and the possible impact. Do not include credentials, enrollment tickets, cookies, CSRF tokens, private paths, repository contents, agent prompts, transcripts, local databases or real session/thread identifiers. Do not test against other people's systems. No fixed response or disclosure timeline is promised.

## Supported scope and release status

Security fixes target the latest `main` branch. Older commits and experimental branches are not independently supported. A successful CI run or merged implementation is not evidence of an independently audited or published release.

- **v0.5.0** is the latest documented tagged release; its [security assessment](docs/V0_5_SECURITY.md) and [validation](docs/V0_5_VALIDATION.md) describe their actual scope.
- **v0.6 Agent Studio and v0.7 workflow engine** are integrated into `main` but have not been separately released. See [Agent Studio validation](docs/V0_6_VALIDATION.md) and [workflow limits](docs/V0_7_WORKFLOW_ENGINE.md).
- The **v0.8 Delivery authorization foundation** is unreleased. It is a separate ingress and is **not permission to execute GitHub remote writes**. Consult the [Delivery threat model](docs/DELIVERY_THREAT_MODEL.md), [security design](docs/DELIVERY_PRODUCTION_SECURITY.md) and [activation checklist](docs/DELIVERY_PRODUCTION_CHECKLIST.md) before evaluating it.

Check actual GitHub tags/releases before relying on these version statements.

## Dashboard and Delivery are separate trust boundaries

The local dashboard is for a **single trusted operator** and must remain bound to loopback. **Never expose dashboard port 4310, Vite, task/workflow endpoints or SSE through a tunnel, public listener or reverse proxy.** Browser confirmation is not a substitute for backend authorization.

The dedicated Delivery API has a different, currently unreleased authorization model: trusted operator enrollment, expiring sessions, live workspace grants, exact HTTPS Origin/Host, CSRF checks and one-use approval/intent records. Its intended deployment requires independently verified TLS, credential scope, host configuration, operational safeguards and security review. **It currently exposes no HTTP commit, push, publication, merge, deployment or automatic retry endpoint.** A reserved transfer intent is not authorization to execute a remote write. Do not mount the legacy or new unreviewed write executors or treat this foundation as production-ready.

## Agent execution and recovery

Read-only tasks use restrictive filesystem permissions. Isolated writes require configured authorized roots, dedicated owned worktrees and explicit operator confirmation. Worktree ownership, Git metadata, lease and revision checks are conservative; uncertain cleanup and interrupted operations fail closed. Do not assume arbitrary same-user filesystem activity can be isolated.

Host verification is disabled by default. Enabling it requires a separate operator opt-in and can execute project scripts with full host permissions **outside** the agent sandbox. Reviewer/QA native read-only checks are a different mechanism; approval of QA never authorizes host verification. Neither fixture tests nor mock GitHub responses establish safe live Codex execution or remote-write correctness.

For implementation-specific assumptions, limitations and recovery instructions, consult the [runtime security model](docs/SECURITY.md), [workspace recovery](docs/WORKSPACE_RECOVERY.md), [MVP acceptance gates](docs/MVP_STABILIZATION_CHECKLIST.md) and [Delivery activation gates](docs/MVP_EVIDENCE_AND_ACTIVATION_GATES.md). The [v0.4 security audit](docs/V0_4_SECURITY_AUDIT.md) records historical reproduced issues, not a blanket safety certification.
