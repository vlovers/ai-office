import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeliveryGitHubCredentials,
  type DeliveryReadCredential,
} from '../src/server/delivery-github-credentials.js';
import { deliverySecurityFixture } from './fixtures/delivery-security.js';

const token = `github_pat_TEST_${'A'.repeat(25)}`;
const repository = 'vlovers/ai-office';
const endpoint = `https://api.github.com/repos/${repository}/git/ref/heads/main`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const credential = (): DeliveryReadCredential => ({
  id: 'test-version-1',
  token,
  repository,
  expiresAt: Date.now() + 60_000,
  permissions: { contents: 'read', pullRequests: 'read' },
});

describe('server-only least-privilege GitHub credential boundary', () => {
  it('hashes quarantine identifiers even when a provider accidentally uses a secret as its ID', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const manager = new DeliveryGitHubCredentials(
        db,
        async () => ({ ...credential(), id: token }),
        async () => new Response(null, { status: 401 }),
      );
      await expect(
        manager.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' }),
      ).rejects.toThrow();
      const rows = db.prepare('SELECT * FROM delivery_revoked_credentials').all();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
    } finally {
      db.close();
    }
  });

  it('fails closed on credential clock rollback across manager restart', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let calls = 0;
      const provider = async () => ({ ...credential(), expiresAt: 60_000 });
      const transport = async () => {
        calls++;
        return Response.json({});
      };
      await new DeliveryGitHubCredentials(db, provider, transport, () => 1000).readOnlyFetcher(
        repository,
        ['main'],
      )(endpoint, { method: 'GET' });
      await expect(
        new DeliveryGitHubCredentials(db, provider, transport, () => 999).readOnlyFetcher(
          repository,
          ['main'],
        )(endpoint, { method: 'GET' }),
      ).rejects.toThrow('unavailable');
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });

  it('attests exact refs through the authenticated HTTP facade without returning or persisting a token', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let headSha = '';
    let baseSha = '';
    const t = await deliverySecurityFixture(
      (db, now) =>
        new DeliveryGitHubCredentials(
          db,
          async () => credential(),
          async (url, init) => {
            requests.push({ url, init });
            const isBase = url.endsWith('/main');
            return Response.json({
              ref: `refs/heads/${isBase ? 'main' : 'ai-office/12345678-1234-1234-1234-123456789abc'}`,
              object: { type: 'commit', sha: isBase ? baseSha : headSha },
            });
          },
          now,
        ),
    );
    cleanups.push(t.close);
    headSha = t.workspace.headSha;
    baseSha = t.workspace.baseSha;
    const result = await t.request('/workspaces/workspace-a/remote-status', { body: {} });
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ headSha, baseSha, remoteWritesEnabled: false });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toMatch(
        /^https:\/\/api.github.com\/repos\/vlovers\/ai-office\/git\/ref\/heads\//,
      );
      expect(request.init.method).toBe('GET');
      expect(request.init.redirect).toBe('error');
      expect((request.init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${token}`,
      );
    }
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(
      JSON.stringify(t.db.prepare('SELECT * FROM delivery_operator_sessions').all()),
    ).not.toContain(token);
  });

  it.each([401, 403])(
    'quarantines HTTP %i credentials durably and never falls back to anonymous requests',
    async (status) => {
      const db = new DatabaseSync(':memory:');
      try {
        let calls = 0;
        const manager = new DeliveryGitHubCredentials(
          db,
          async () => credential(),
          async () => {
            calls++;
            return new Response(token, { status });
          },
        );
        const fetcher = manager.readOnlyFetcher(repository, ['main']);
        await expect(fetcher(endpoint, { method: 'GET' })).rejects.toMatchObject({
          statusCode: 503,
        });
        const reopenedManager = new DeliveryGitHubCredentials(
          db,
          async () => credential(),
          async () => {
            calls++;
            return Response.json({});
          },
        );
        await expect(
          reopenedManager.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' }),
        ).rejects.toThrow('unavailable');
        expect(calls).toBe(1);
        expect(
          JSON.stringify(db.prepare('SELECT * FROM delivery_revoked_credentials').all()),
        ).not.toContain(token);
      } finally {
        db.close();
      }
    },
  );

  it('blocks expired, revoked, wrong-repository and excessive permission metadata before network access', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let calls = 0;
      const variants = [
        { ...credential(), expiresAt: 1 },
        { ...credential(), repository: 'evil/repo' },
        { ...credential(), permissions: { contents: 'write', pullRequests: 'read' } },
        { ...credential(), token: `${token}\n` },
        {
          ...credential(),
          permissions: { contents: 'read', pullRequests: 'read', administration: 'write' },
        },
      ];
      for (const value of variants) {
        const manager = new DeliveryGitHubCredentials(
          db,
          async () => value as DeliveryReadCredential,
          async () => {
            calls++;
            return Response.json({});
          },
        );
        await expect(
          manager.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' }),
        ).rejects.toMatchObject({ statusCode: 503 });
      }
      const manager = new DeliveryGitHubCredentials(
        db,
        async () => credential(),
        async () => {
          calls++;
          return Response.json({});
        },
      );
      manager.revoke('test-version-1');
      await expect(
        manager.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects writes, foreign hosts/repos, unapproved refs, pagination injection and credential-bearing URLs', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let calls = 0;
      const manager = new DeliveryGitHubCredentials(
        db,
        async () => credential(),
        async () => {
          calls++;
          return Response.json({});
        },
      );
      const fetcher = manager.readOnlyFetcher(repository, ['main']);
      for (const url of [
        endpoint.replace('api.github.com', 'evil.example'),
        endpoint.replace(repository, 'evil/repo'),
        endpoint.replace('/main', '/other'),
        `${endpoint}?token=${token}`,
        endpoint.replace('https://', `https://${token}@`),
        `https://api.github.com/repos/${repository}/pulls?state=all&page=1&per_page=100&page=2`,
        `https://api.github.com/repos/${repository}/pulls/1/merge`,
        `https://api.github.com/repos/${repository}/pulls/1?unexpected=1`,
        `https://api.github.com/repos/${repository}/pulls/1#fragment`,
        `https://api.github.com/repos/${repository}/pulls/1/`,
        `https://api.github.com/repos/${repository}/pulls/1%2Fmerge`,
        `https://api.github.com/repos/${repository}/pulls/01`,
        `https://api.github.com/repos/${repository}/pulls/1?state=all`,
      ])
        await expect(fetcher(url, { method: 'GET' })).rejects.toThrow('unavailable');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
        await expect(fetcher(endpoint, { method })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it('sanitizes transport/provider failures, token echoes, excessive bodies, rate limits and redirects', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const fetchers = [
        async () => {
          throw new Error(`Authorization: Bearer ${token}`);
        },
        async () => new Response(token),
        async () => new Response('x'.repeat(1024 * 1024 + 1)),
        async () => new Response(token, { status: 429 }),
        async () =>
          new Response(token, {
            status: 302,
            headers: { Location: `https://evil.example/${token}` },
          }),
      ];
      for (const transport of fetchers) {
        const manager = new DeliveryGitHubCredentials(db, async () => credential(), transport);
        await expect(
          manager.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' }),
        ).rejects.toThrow('Delivery service unavailable.');
      }
      const unavailable = new DeliveryGitHubCredentials(db, async () => {
        throw new Error(token);
      });
      await expect(
        unavailable.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' }),
      ).rejects.toThrow('Delivery service unavailable.');
    } finally {
      db.close();
    }
  });

  it('revalidates authorization after asynchronous credential resolution before using a token', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let calls = 0;
      let allowed = true;
      const manager = new DeliveryGitHubCredentials(
        db,
        async () => {
          allowed = false;
          return credential();
        },
        async () => {
          calls++;
          return Response.json({});
        },
      );
      await expect(
        manager.readOnlyFetcher(repository, ['main'], () => {
          if (!allowed) throw new Error('revoked');
        })(endpoint, { method: 'GET' }),
      ).rejects.toThrow('unavailable');
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it('returns a safe 503 through real HTTP when upstream errors contain a token', async () => {
    const t = await deliverySecurityFixture(
      (db) =>
        new DeliveryGitHubCredentials(
          db,
          async () => credential(),
          async () => {
            throw new Error(token);
          },
        ),
    );
    cleanups.push(t.close);
    const result = await t.request('/workspaces/workspace-a/remote-status', { body: {} });
    expect(result.response.status).toBe(503);
    expect(result.body).toEqual({ error: 'Delivery service unavailable.' });
    expect(JSON.stringify([...result.response.headers, result.body])).not.toContain(token);
  });

  it('returns 401 and sends no upstream request when a session is revoked while credentials resolve', async () => {
    let revoke = () => {};
    let calls = 0;
    const t = await deliverySecurityFixture(
      (db) =>
        new DeliveryGitHubCredentials(
          db,
          async () => {
            revoke();
            return credential();
          },
          async () => {
            calls++;
            return Response.json({});
          },
        ),
    );
    cleanups.push(t.close);
    revoke = () => t.sessions.revoke(t.auth.token);
    const result = await t.request('/workspaces/workspace-a/remote-status', { body: {} });
    expect(result.response.status).toBe(401);
    expect(calls).toBe(0);
  });
});
