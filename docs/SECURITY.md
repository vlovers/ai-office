# Security model

AI Office is a single-user local development tool for trusted repositories. It is not a container, a multi-user service, a secret scanner or an authorization boundary against other processes running as the same OS user. Do not expose it through a proxy or tunnel. Local-first describes control and metadata; model inference is remote.

## HTTP and authentication

Both services bind loopback. Host/Origin and Fetch Metadata checks reject cross-site use; mutations require JSON and strict schemas. No CORS wildcard is enabled. SSE renders text, not HTML, and replays bounded persisted events. Browser confirmation communicates user intent, while backend validation and the OS/runtime enforce actual restrictions.

Existing CLI-owned ChatGPT authentication is preferred, without reading/copying credential files in application code or API-key fallback. Explicit API mode is separate and configured only on the backend. Private session bindings tie resume to authentication context, mode, model/provider and agent. Read-only/write mode changes cannot reuse a session. CLI diagnostics are sanitized; configured API keys and obvious key patterns are redacted from output/public responses. Prompts and transcripts are plaintext local data: do not paste secrets into them. Redaction is not comprehensive.

## Agent execution

Read-only remains the default. Writes require configured absolute authorized/workspace roots and explicit start confirmation. Repository realpaths, source Git directories and common Git metadata must be inside the authorized root. A linked checkout alone does not authorize writes to metadata outside that root. Workspace roots must be canonical, free of symlink components and outside existing Git checkouts. Creation reserves a new UUID directory and dedicated branch at HEAD, never copies primary-checkout edits and never overwrites an existing path/ref.

The pinned Codex runtime uses a named filesystem profile: root deny, minimal runtime reads, isolated worktree writes or registered-checkout reads, command network/web search disabled, and exact denies for the worktree's Git pointer and known metadata/secret paths. Descendant deny globs cover known nested metadata/credential names. User config/rules and automatic AGENTS.md discovery are suppressed; project context is untrusted. Legacy sandbox options are not mixed with the restrictive profile. Actions requiring unavailable interactive approval remain blocked; there is no full-access fallback.

The supervising worker receives a private HOME and no inherited credentials. CLI authentication is passed privately to the CLI subprocess; agent shell commands receive a minimal environment. These are tested runtime controls, not a VM guarantee. Machine-managed configuration and supported runtime behavior remain assumptions. On Linux/WSL, deny globs are snapshots per sandboxed process, bounded at depth 32: files created after process startup or beyond the scan depth are not comprehensively protected by globs. Store credentials outside registered repositories. See [official permissions limitations](https://learn.chatgpt.com/docs/permissions).

## Git review and ownership

Git is the source of truth for diffs against the saved base, including committed, staged, unstaged and untracked changes. Backend Git uses literal pathspecs, disables hooks, fsmonitor, configured clean/smudge/process filters, external diff/textconv and submodule inspection. Otherwise AI-controlled attributes can trigger host-side helpers even in a trusted repository. Filter-dependent materialization, including Git LFS, is deliberately suppressed; pointer files may require separate trusted manual hydration. Git metadata parsing and configuration itself still assume a trusted repository/OS Git installation.

Workspace ownership includes canonical source/common/worktree identities and device/inode/birth-time fingerprints, checked before resume/review/cleanup and again after authentication preparation. Matching names alone are insufficient. Common-Git-directory and legacy per-worktree leases coordinate aliases across instances. Unknown/stale leases are never stolen. External editors do not honor these leases.

Known sensitive paths are withheld from diffs. Untracked reads use no-follow file handles, identity/canonical checks and bounded reads. These checks and filesystem metadata revisions reduce accidental races; they do not make a transaction with an adversarial same-user filesystem process. Review revisions bind decisions to observed HEAD/index/status, bounded filesystem metadata and command configuration. Refresh after edits. Do not edit a worktree during confirmation or cleanup. Large/binary/sensitive content can require local inspection.

## Keep and Reject

Keep preserves the isolated files/branch and closes agent continuation. Integration is manual. Reject requires a fresh review revision and explicit confirmation. It revalidates ownership, branch and unchanged HEAD, refuses ignored files and nested bare/non-bare repositories, and enforces a 50,000-entry scan limit. Only then does Git remove the owned worktree. Branches are retained. No automatic commit, reset, merge, push, force-push or branch deletion occurs.

Operation intents are persisted before creation, removal and verification; workspace/task attachment is transactional. A crash or failed persistence step produces an explicit recovery state rather than a guessed success. Filesystem mutations and SQLite cannot be one atomic transaction: ambiguous or partial operations stay blocked. Legacy workspaces lacking fingerprints are not adopted. See [workspace recovery](WORKSPACE_RECOVERY.md).

## Host verification

Verification is **disabled by default**. Configuring command labels alone does not enable it: the operator must set `AI_OFFICE_ALLOW_HOST_VERIFICATION=1`, inspect scripts and explicitly accept full host execution. The UI shows configured argv and warns about credentials, networking and other checkouts. The backend requires a fresh revision and separate host confirmation. HTTP clients cannot supply an executable, shell string or environment.

Opted-in verification executes trusted project code, including any AI edits, with the OS user's permissions. It is outside the Codex sandbox and can access files/network despite a minimal environment. Never run unreviewed tests or scripts. This is a deliberate trust boundary, not a sandboxed validation guarantee.

A separate process-group worker owns the command's timeout, output bound and backend-disconnect handler. Results are reported only after worker closure and group cleanup. Normal shutdown aborts verification and stops agents in parallel. SIGKILL of the backend disconnects the supervisor; its own timeout remains independent. Default command runtime is 60 seconds (internally capped at 120), output is capped at roughly 128,000 characters, and a startup backstop is additional. Deliberately detached processes can escape process-group supervision; this is not a container.

Cleanup accepts only a delivered SIGKILL or confirmed group absence. Transient EPERM is retried conservatively; persistent uncertainty preserves leases and reports interruption rather than claiming a stop. Cancellation cannot undo completed writes or provider charges. Unknown resources and uncertain cleanup require manual inspection.

## Storage and retained limitations

Metadata/runtime directories are private and excluded from Git. SQLite uses WAL/foreign keys/transactions; schema v6 refuses older application readers and retains unfinished operation diagnostics. There are no quotas, general backup/retention/encryption facilities or account-wide spend limits. Host crashes cannot emit final events. Never clear a lock by deleting the database. No recovery path automatically deletes unknown/user-modified resources.

The full evidence-based findings and remaining boundaries are in [the v0.4 security audit](V0_4_SECURITY_AUDIT.md). Report vulnerabilities privately as described in the repository's [security policy](../SECURITY.md).

Review feedback, immutable submitted iterations, resume validation and new abuse cases are documented in the [v0.5 threat model](V0_5_SECURITY.md). All v0.4 filesystem, Git, process cleanup and host-verification boundaries still apply.
