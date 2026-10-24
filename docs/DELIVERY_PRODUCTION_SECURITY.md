# Delivery production security foundation

Status: **unreleased**. The dedicated Delivery API authenticates operators,
enforces workspace grants, issues/revokes one-use approvals, reserves durable
transfer intents and attests GitHub refs with GET only. It has **no commit, push,
publication, merge, deployment or retry endpoint**. An intent is a reservation,
never permission to run Git after releasing its lease.

The existing single-user local dashboard is a different ingress. Never proxy
its port 4310, Vite, task/workflow routes or SSE onto the Delivery ingress.
Its existing delivery confirmations remain inert previews, without authority
to issue authenticated approvals.

## Verified audit baseline

Audited actual `main` at `a70940d`, merged PR metadata and code for
[#51](https://github.com/vlovers/ai-office/pull/51),
[#52](https://github.com/vlovers/ai-office/pull/52),
[#63](https://github.com/vlovers/ai-office/pull/63),
[#64](https://github.com/vlovers/ai-office/pull/64),
[#65](https://github.com/vlovers/ai-office/pull/65), and
[#58 including progress comments](https://github.com/vlovers/ai-office/issues/58).

Verified: durable publication/transfer journals, one-use stage approval ledgers,
atomic transfer approval/intent persistence, common-repository leases, local Git
attestation, exact GitHub PR/ref validation and independent-process recovery.
They did not authenticate HTTP operators or enforce workspace grants. Local
Host/Origin checks were not a production session boundary. This service composes
the existing controls; it does not infer authentication from their types.

## Operator authentication

`DeliverySessions` is separate from agent/model conversation sessions. A trusted
OS administrator enables operators and grants explicit workspace operations with
`npm run delivery:admin`. There is no HTTP administration or self-registration.
The administrator conveys a random 256-bit, one-use, 60-second enrollment ticket
to the verified operator through a trusted channel. Exchange produces a fresh
random session; the browser cannot select operator/session identity. This is
the supported administrator-mediated authentication path. Any future SSO adapter
must verify issuer, audience, identity and replay protection before provisioning.

SQLite stores ticket/session/CSRF hashes, generated session UUIDs, expiry and
revocation; it stores no bearer secrets or GitHub tokens. Sessions expire after
30 minutes; the server-only configurable maximum is eight hours. Every use reads
the enabled operator, live session and exact workspace/operation grant. Logout
revokes one session; administrator `disable` revokes all its sessions and pending
tickets. Re-enabling never restores those sessions/tickets. Grant removal takes
effect on the next authorization. A persisted clock watermark rejects rollback,
including after restart. Database failures never grant fallback authority.

Independent grants: `review`, `approve:commit`, `approve:push`, `approve:draft-pr`,
`reserve:commit`, `reserve:push`, `remote:read`. There are no wildcards or implicit
admin privileges. Reservation requires both current stage approval and reservation
grants. Workspace IDs in URLs select resources checked against server grants.
Strict JSON rejects operator/session IDs, workspace claims, credentials, paths,
destinations, SHAs, permissions and extra approval claims.

## HTTP protections and routes

The dedicated Fastify app requires one canonical configured **HTTPS** public
origin and exact Host. A trusted TLS proxy preserves Host and forwards only to
its loopback listener, default port 4311. Forwarded identity/Host/protocol headers
are ignored. There is no CORS. Mutations require exact Origin (missing/`null`
rejected), JSON and session-bound `X-CSRF-Token`. Enrollment uses exact Origin
and `X-Delivery-Enrollment: 1`, also protecting login CSRF. Fetch Metadata rejects
cross-site and sibling same-site requests.

`__Host-ai-office-delivery` is Secure, HttpOnly, SameSite=Strict, Path=/, with
bounded Max-Age and no Domain. Duplicate cookies are rejected. The bearer is
issued only in Set-Cookie; authenticated `GET /session` retrieves the session
CSRF token after refresh. CSRF secrets never appear in URLs/cookies. Bodies are
limited to 8 KiB, strict schemas bound input, and request/connection timeouts are
bounded. Responses use no-store, nosniff, no-referrer, restrictive CSP and HSTS.
Application logging is disabled. Ingress/vault logs must separately omit
cookies, Authorization, tickets and request secrets.

| Method | Route under `/api/delivery`                    | Body / purpose                                                 |
| ------ | ---------------------------------------------- | -------------------------------------------------------------- |
| POST   | `/session`                                     | `{ticket}`, custom enrollment header                           |
| GET    | `/session`                                     | Session CSRF token and expiry                                  |
| POST   | `/logout`                                      | `{}`, revoke and clear cookie                                  |
| GET    | `/workspaces/:id/review`                       | Fresh leased registered snapshot                               |
| POST   | `/workspaces/:id/approvals`                    | `{operation,reviewId,confirmed:true}`                          |
| POST   | `/workspaces/:id/approvals/:approvalId/revoke` | `{operation,confirmed:true}`                                   |
| POST   | `/workspaces/:id/transfer-intents`             | `{stage,reviewId,approvalId,confirmed:true}`, reservation only |
| POST   | `/workspaces/:id/remote-status`                | `{}`, GET-only exact ref attestation                           |

Fixed public errors: **401** invalid/absent/expired/revoked session or ticket;
**403** Origin/Host/CSRF/grant rejection; **409** stale review, lease conflict,
mismatched/expired/replayed approval or existing intent; **503** unavailable
credential/storage/configuration/upstream. Input is 400, excess body 413, media
type 415. No nested errors, Git stderr, filesystem paths, unknown field contents,
upstream bodies or provider exceptions are reflected.

## Approval integration

The immutable server registry pins repository/worktree identity, branch,
destination, review fingerprint and exact head/base SHA. `reviewId` also binds
the workspace and registered paths. Clients may acknowledge it, never replace
it. Review/approval/reservation re-attests clean Git state, branch, head, base,
origin and common repository ownership under the existing shared Git lease.
Drift requires trusted review/registration refresh and a new approval.

Issuance checks current authorization inside `BEGIN IMMEDIATE` on the same
SQLite connection as the existing ledgers. Reservation rechecks live session
and grants **inside** the existing atomic approval-consumption/intent transaction
after asynchronous Git verification. Competing requests cannot reserve twice.
Approvals bind stage, operator, session, workspace, repository, branch, review
operation key and head/base SHA. Another session of the same operator cannot
consume them. Push approval needs a confirmed matching commit; Draft PR approval
needs both independently confirmed commit and push receipts.

Legacy low-level executors remain trusted server libraries. String-valued
`TrustedDeliveryOperator` is not an authentication proof. Future write adapters
must provide final live authorization, retain the same lease through one attempt
and receipt verification, and never execute from an HTTP reservation after its
lease is released. This implementation mounts no such adapter.

## GitHub credentials

`DeliveryGitHubCredentials` resolves tokens from a server-owned vault/provider
or private environment. It constructs Authorization inside a closure, allowing
only exact-repository/ref/PR GET requests. It rejects arbitrary URLs, writes,
other hosts/repos, unapproved branches and redirects. Every request resolves an
unexpired credential and rechecks authorization after asynchronous resolution.
A 401/403 durably quarantines that credential version in SQLite; provision a new
version after fixing authorization. There is no anonymous fallback or retry.
429/timeouts/malformed receipts remain blocked.

Provision a repository-scoped GitHub App installation or fine-grained token with
Contents: read, Pull requests: read and mandatory metadata. Provider permission
metadata is checked, but opaque token scopes cannot be independently proved
by this adapter; the deployment operator must audit them. Actual outgoing
capabilities remain GET-only even if a token is overprivileged. No write scope
is required. Supply real expiry and rotation through the trusted provider.

Upstream bodies are capped at 1 MiB, transport timeout at ten seconds; response
headers are discarded before existing strict parsers. Credential echoes and
transport/provider errors become fixed errors. Git's existing minimal environment
does not inherit the token. Frontend code imports none of these server modules;
no `VITE_` variable holds credentials.

## Bootstrap, storage and rollback

Use Node 24 and a private state directory outside registered repositories,
default `.ai-office/delivery`. A trusted `config.json` must be regular, owner-only
(0600); symlink files, wrong owner, group/world access and oversized files are
rejected. SQLite is private, uses WAL/FULL synchronous and a two-second busy
timeout. The runtime holds its metadata lock and runs the existing registered
recovery coordinator **before listen**. Unknown/stale unresolved registrations
or held Git leases stop startup. Interrupted intents become uncertain, without
replay. The supported registry is immutable trusted configuration; it is not
automatically adopted from the dashboard task database.

Configuration shape (placeholders must be replaced from independently reviewed
server records, never browser JSON):

```json
{
  "publicOrigin": "https://delivery.example.com",
  "workspaces": [
    {
      "workspaceId": "workspace-a",
      "repository": { "path": "/srv/source", "gitDir": "/srv/source/.git" },
      "worktree": { "path": "/srv/workspaces/a", "gitDir": "/srv/source/.git/worktrees/a" },
      "plan": {
        "allowed": true,
        "destination": "https://github.com/OWNER/REPO",
        "branch": "ai-office/12345678-1234-1234-1234-123456789abc",
        "baseBranch": "main",
        "revision": "REPLACE_WITH_REVIEWED_64_HEX_FINGERPRINT",
        "draft": true
      },
      "headSha": "REPLACE_WITH_REVIEWED_COMMIT_SHA",
      "baseSha": "REPLACE_WITH_REVIEWED_MAIN_SHA"
    }
  ]
}
```

Run `npm run delivery:admin -- enable alice`, then grant only necessary operations,
for example `npm run delivery:admin -- grant alice workspace-a review` and
`... grant alice workspace-a approve:commit`. Start `npm run dev:delivery`, or
build and use `npm run start:delivery`. `... ticket alice` displays the single-use
ticket once for trusted handoff; do not capture it in logs, URLs or shell history.
A same-origin client exchanges it using the custom enrollment header, then sends
the secure cookie and returned CSRF header. `... revoke-grant alice workspace-a
review` removes a grant; `... disable alice` revokes all operator sessions/tickets.

Environment: `AI_OFFICE_DELIVERY_DATA_DIR`, `AI_OFFICE_DELIVERY_CONFIG`,
`AI_OFFICE_DELIVERY_PORT`. Optional private read credentials:
`AI_OFFICE_DELIVERY_GITHUB_TOKEN`, `AI_OFFICE_DELIVERY_GITHUB_CREDENTIAL_ID`,
`AI_OFFICE_DELIVERY_GITHUB_REPOSITORY`, `AI_OFFICE_DELIVERY_GITHUB_EXPIRES_AT`
(epoch milliseconds). Absent/invalid credentials return 503 for remote status.

Security schema version 1 is additive in dedicated `delivery.sqlite`; the
dashboard/agent Store schema and data are unchanged. Future security versions
are refused. Stop the listener before rollback and retain SQLite/WAL, registry,
consumed approvals and unresolved journals. Older binaries must not serve this
ingress or reinterpret its records. Restore tested code/config/backups together;
never delete journals or leases to make a blocked operation eligible again.

## Validation and references

Real loopback HTTP, temporary Git and file-backed SQLite tests cover sessions,
grants, strict input, Origin/CSRF, two-server replay, expiry/revocation and Git
drift. Independent Node processes cover startup contention, session persistence,
intent recovery and CLI revocation. GitHub fixture transports cover credential
expiry/rejection/quarantine/leakage without contacting GitHub. CI retains browser
and native checks and adds Delivery lint. TLS/real-browser ingress and actual
GitHub permissions remain deployment validation gates.

See [threat model](DELIVERY_THREAT_MODEL.md) and
[production checklist](DELIVERY_PRODUCTION_CHECKLIST.md). CSRF follows
[OWASP's synchronizer-token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html);
credential provisioning follows
[GitHub's endpoint permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).
