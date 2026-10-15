# Trust boundaries and recovery

The [Phase 1.2 dashboard](PHASE_1_2_DASHBOARD.md) prefers the existing CLI-owned ChatGPT login without copying or opening credential files in application code. Local mode excludes API-key variables and never selects API billing on failure. Task tools remain repository-scoped and read-only; API mode requires an explicit UI selection and backend-only key configuration.

## Enforced boundaries

- Both services bind to `127.0.0.1`. API Host/Origin checks allow the actual bound loopback port (4310 by default) and the local Vite proxy origin on 5173. Fetch Metadata rejects cross-site access. No CORS wildcard is enabled. Strict JSON schemas reject unknown properties, including shell commands, credential payloads and SDK options.
- Repository registration uses absolute real paths and validates Git worktree roots. Nested directories, missing paths, bare repositories, excluded project names, and changed worktree identities are rejected. Estima and Pixel Office are excluded by path component, including canonical Git-directory paths. No agents were run in either repository.
- Codex's named profile denies root filesystem access, allows its minimal system runtime paths, grants the registered repository read access, denies temp roots, and denies repository `.git`, `.codex`, `.agents`, `.aws`, environment files and selected credential-file patterns. Command networking and web search are disabled. Unsupported sandbox policies fail rather than falling back to full access.
- No unrestricted sandbox, automatic approval reviewer, `never` approval policy, or approval bypass is enabled. With no interactive SDK approval channel, edits, destructive operations, pushes, merges, and database operations have no approval route in this MVP. Repository writes remain blocked even if a prompt asks for them. Review proposals manually outside the application.
- The worker gets an application-owned private HOME/CODEX_HOME and no inherited credentials. Its SDK subprocess receives only the selected CLI environment through private IPC: local mode gets existing auth-home paths and a minimal PATH, with no key/access-token/cloud/database/proxy variables; explicit API mode gets an isolated home and its configured API key. The CLI owns its login and normal refresh. Shell commands inside Codex inherit no CLI environment and receive a minimal PATH. No credential file is opened/copied by application code; none is exported through an HTTP endpoint.
- Execution ignores inherited user configuration/rules and pins user review routing. Connection status is cached for polling and checked again before a task; actual expired-login failures become Authentication required. Raw CLI stderr/provider authentication diagnostics are withheld. Private session bindings are not browser-visible and cannot silently switch authentication modes on resume.
- Automatic `AGENTS.md` context discovery is disabled with `project_doc_max_bytes=0` so parent-directory instructions are not imported into task context.
- One active agent and cross-instance worktree leases prevent shared execution. No write provider is enabled. External editors and unrelated coding tools do not participate in these leases.
- Runtime directories use private permissions and are excluded from Git. The application API key is redacted from persisted output and obvious `sk-…` values are scrubbed. Errors and HTTP logs do not dump the server environment. Raw task prompts are intentionally persisted; never paste secrets into them.
- The only backend Git calls are fixed read-only identity/status operations with bounded execution. The service opens only its own SQLite file; it has no production database connection code. Model-generated commands are isolated from user database credentials, networking, and filesystem writes.

## Scope and limits

This is a **single-user local tool**, not a multi-user or remote service. There is no account system or authorization against other processes running as the same OS user. Local clients can call the API directly. Do not expose it through a reverse proxy, tunnel, or public interface.

Only register repositories you own and trust. Registration authorizes sending task context from that repository to the selected model provider. Local-first means metadata and control are local; model inference is remote. This is not an air-gapped application.

Filesystem permissions are beta Codex runtime behavior, not a VM boundary. Minimal OS/runtime paths remain readable. Secret globs are defense in depth, not a guarantee for every possible secret filename; recursive deny-glob expansion is bounded at depth 32 on platforms that require expansion. Store credentials outside registered repositories. Do not register a home directory or a directory containing credential stores. Untrusted project config is disabled through the project trust setting; machine-managed requirements can still constrain or reject startup.

Task prompts and repository content may contain prompt injection. The read-only profile, network restrictions, isolated environment, and missing approval channel provide enforcement; prompt instructions alone are not treated as a security boundary. Git metadata is inspected by the local Git executable during registration/status; repositories with malicious local Git configuration are outside this MVP's trusted-repository assumption.

SSE output is rendered as text, not HTML. Metadata and session transcripts are plaintext local files with OS permissions, not encrypted storage. Retention/rotation, backups, token accounting, and disk quotas are not implemented. Event and runtime limits bound each run, not lifetime database growth. Redaction is not a general secret scanner.

## Stop and shutdown

Stop requests `AbortController.abort()` through the SDK. The supervising worker aborts on server disconnect or termination. The backend kills remaining process-group members after a grace period and holds the repository lease through cleanup. State is `stopping` until that finishes. Authentication preflight can delay Stop until its bounded metadata RPC completes. Ctrl-C/SIGTERM ends SSE responses, stops the active agent, and closes remaining HTTP connections before closing SQLite and releasing the server lease.

Cancellation cannot roll back already completed actions, undo sent provider requests, or guarantee zero additional provider charges. POSIX process groups are not a container; deliberately detached external processes are not covered by group supervision. Phase 1's read-only/network-denied task sandbox and fail-closed leases limit the consequences. A host crash or power loss cannot emit a final event.

## Unclean termination recovery

The server uses `<data-directory>/server.lock`; worktree leases live under the OS temp directory as `ai-office-worktrees-<uid>/<sha256-of-canonical-git-directory>`. Owner files record the server PID, resource, and timestamp. An existing lease fails closed even if its recorded PID appears dead, to avoid PID reuse and orphaned-child races.

After an abnormal termination:

1. Stop remaining AI Office, worker, and Codex processes associated with that instance. Inspect processes and the lease's `owner.json`; do not rely solely on PID liveness.
2. Inspect the repository and preserve anything you need. Do not launch a second write agent into that worktree.
3. Only after confirming cleanup, manually remove the corresponding stale lock directory. The application never automatically steals or clears unknown leases.
4. Restart the backend. SQLite marks previously `running`/`stopping` tasks `interrupted` and retains their event history/thread IDs.
5. Create a new task in that repository and choose the saved session's connection mode. If the native transcript in its original CLI home is gone, resume fails visibly; SQLite's ID alone cannot reconstruct the transcript. Pre-1.2 sessions without a verified binding remain history and require a new session.

Normal shutdown releases its locks. Do not delete SQLite/session data to clear a lock. No startup, test, or application action automatically commits, pushes, or merges.
