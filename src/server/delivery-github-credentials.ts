import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DeliverySecurityError } from './delivery-sessions.js';

export type DeliveryReadCredential = {
  /** Stable vault/installation credential version; never the token itself. */
  id: string;
  token: string;
  repository: string;
  expiresAt: number;
  permissions: { contents: 'read'; pullRequests: 'read' };
};
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const credentialHash = (id: string) => createHash('sha256').update(id).digest('hex');

/**
 * Server-owned vault adapter. Tokens never leave the request closure. Only
 * exact-repository GETs are possible, regardless of the actual token's scopes.
 * Deployment must independently provision repository-scoped read credentials.
 */
export class DeliveryGitHubCredentials {
  constructor(
    private readonly db: DatabaseSync,
    private readonly resolve: () => Promise<DeliveryReadCredential>,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS delivery_revoked_credentials (
      credential_id_hash TEXT PRIMARY KEY
    ); CREATE TABLE IF NOT EXISTS delivery_credential_clock (
      id INTEGER PRIMARY KEY CHECK(id=1), last_seen_at INTEGER NOT NULL
    )`);
  }

  revoke(credentialId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO delivery_revoked_credentials VALUES (?)')
      .run(credentialHash(credentialId));
  }

  readOnlyFetcher(
    repository: string,
    branches: readonly string[],
    authorize?: () => void,
  ): Fetcher {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) || /\/(?:\.|\.\.)$/.test(repository))
      throw new DeliverySecurityError(503);
    const prefix = `https://api.github.com/repos/${repository}`;
    const refs = branches.map(
      (branch) => `${prefix}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
    );
    return async (input, init) => {
      try {
        const url = new URL(input);
        const pullList =
          url.origin + url.pathname === `${prefix}/pulls` &&
          url.searchParams.get('state') === 'all' &&
          /^[1-9]\d{0,3}$/.test(url.searchParams.get('page') ?? '') &&
          /^(?:[1-9]\d?|100)$/.test(url.searchParams.get('per_page') ?? '') &&
          [...url.searchParams.keys()].sort().join(',') === 'page,per_page,state';
        const pullDetail =
          input.startsWith(`${prefix}/pulls/`) &&
          /^[1-9]\d*$/.test(input.slice(`${prefix}/pulls/`.length));
        if (
          init.method !== 'GET' ||
          init.body ||
          (!refs.includes(input) && !pullList && !pullDetail) ||
          url.hash ||
          url.username ||
          url.password
        )
          throw new DeliverySecurityError(503);
        const credential = await this.resolve();
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < 0) throw new DeliverySecurityError(503);
        const clock = this.db
          .prepare(
            `INSERT INTO delivery_credential_clock VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at
          WHERE delivery_credential_clock.last_seen_at<=excluded.last_seen_at`,
          )
          .run(now);
        if (clock.changes !== 1) throw new DeliverySecurityError(503);
        if (
          !credential ||
          !/^[A-Za-z0-9_.:@-]{1,200}$/.test(credential.id) ||
          !/^[A-Za-z0-9_]{20,255}$/.test(credential.token) ||
          credential.repository !== repository ||
          credential.permissions?.contents !== 'read' ||
          credential.permissions?.pullRequests !== 'read' ||
          Object.keys(credential.permissions).sort().join(',') !== 'contents,pullRequests' ||
          !Number.isSafeInteger(credential.expiresAt) ||
          credential.expiresAt <= now + 5000 ||
          this.db
            .prepare('SELECT 1 FROM delivery_revoked_credentials WHERE credential_id_hash=?')
            .get(credentialHash(credential.id))
        )
          throw new DeliverySecurityError(503);
        authorize?.();
        const response = await this.fetcher(input, {
          method: 'GET',
          redirect: 'error',
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${credential.token}`,
          },
        });
        if (response.status === 401 || response.status === 403) this.revoke(credential.id);
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== input)
        ) {
          await response.body?.cancel();
          throw new DeliverySecurityError(503);
        }
        // Bound upstream bodies and strip headers before existing receipt parsers.
        const reader = response.body?.getReader();
        if (!reader) throw new DeliverySecurityError(503);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) throw new DeliverySecurityError(503);
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.includes(credential.token)) throw new DeliverySecurityError(503);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        if (
          error instanceof DeliverySecurityError &&
          (error.statusCode === 401 || error.statusCode === 403)
        )
          throw error;
        // Fetch/provider errors may contain Authorization headers or signed URLs.
        throw new DeliverySecurityError(503);
      }
    };
  }
}
