import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryGitHubCredentials,
  type DeliveryReadCredential,
} from '../src/server/delivery-github-credentials.js';

const repository = 'vlovers/ai-office';
const token = `github_pat_TEST_${'A'.repeat(25)}`;
const listing = `https://api.github.com/repos/${repository}/pulls?state=all&per_page=100&page=1`;
const nestedBranch = 'ai-office/12345678-1234-1234-1234-123456789abc';
const ref = `https://api.github.com/repos/${repository}/git/ref/heads/ai-office/12345678-1234-1234-1234-123456789abc`;

function credential(): DeliveryReadCredential {
  return {
    id: 'canonical-url-test-version',
    token,
    repository,
    expiresAt: Date.now() + 60_000,
    permissions: { contents: 'read', pullRequests: 'read' },
  };
}

describe('Delivery credential canonical URL and branch allowlist boundary', () => {
  it.each([
    ['uppercase host', listing.replace('api.github.com', 'API.GITHUB.COM')],
    ['explicit default HTTPS port', listing.replace('api.github.com', 'api.github.com:443')],
    [
      'normalized dot segment',
      listing.replace('/vlovers/ai-office/pulls', '/vlovers/ignored/../ai-office/pulls'),
    ],
    ['encoded page digit', listing.replace('page=1', 'page=%31')],
    ['encoded state alias', listing.replace('state=all', 'state=%61ll')],
    ['encoded per-page digit', listing.replace('per_page=100', 'per_page=%3100')],
    ['extra query parameter', `${listing}&token=secret`],
    ['duplicate page parameter', `${listing}&page=2`],
    ['fragment', `${listing}#fragment`],
    ['userinfo', listing.replace('https://', 'https://test@')],
    ['foreign repository', listing.replace(repository, 'other/repository')],
  ])('rejects %s before resolving a credential or making a request', async (_label, url) => {
    const db = new DatabaseSync(':memory:');
    try {
      const resolve = vi.fn(async () => credential());
      const transport = vi.fn(async () => Response.json([]));
      const fetcher = new DeliveryGitHubCredentials(db, resolve, transport).readOnlyFetcher(
        repository,
        ['main'],
      );
      await expect(fetcher(url, { method: 'GET' })).rejects.toMatchObject({
        statusCode: 503,
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([
    ['empty allowlist', []],
    ['too many branches', Array.from({ length: 17 }, (_, i) => `branch-${i}`)],
    ['empty branch', ['']],
    ['parent traversal', ['feature/../main']],
    ['double slash', ['feature//main']],
    ['trailing slash', ['feature/']],
    ['trailing dot', ['feature.']],
    ['lock suffix', ['main.lock']],
    ['query injection', ['main?token=secret']],
    ['newline', ['main\nother']],
    ['backslash', ['main\\other']],
    ['too long', ['a'.repeat(201)]],
  ])('rejects %s when constructing the credential-scoped ref allowlist', (_label, branches) => {
    const db = new DatabaseSync(':memory:');
    try {
      const resolve = vi.fn(async () => credential());
      const transport = vi.fn(async () => Response.json({}));
      const manager = new DeliveryGitHubCredentials(db, resolve, transport);
      expect(() => manager.readOnlyFetcher(repository, branches)).toThrow(
        'Delivery service unavailable.',
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('allows canonical inventory and nested managed refs without forwarding caller headers', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const resolve = vi.fn(async () => credential());
      const transport = vi.fn(async (url: string, init: RequestInit) => {
        expect([listing, ref]).toContain(url);
        expect(init.method).toBe('GET');
        expect(init.redirect).toBe('error');
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
        expect(new Headers(init.headers).get('x-untrusted')).toBeNull();
        return Response.json({ safe: true });
      });
      const fetcher = new DeliveryGitHubCredentials(db, resolve, transport).readOnlyFetcher(
        repository,
        ['main', nestedBranch],
      );
      const options = {
        method: 'GET',
        headers: { 'x-untrusted': 'browser-header' },
      };
      expect(await (await fetcher(listing, options)).json()).toEqual({ safe: true });
      expect(await (await fetcher(ref, options)).json()).toEqual({ safe: true });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('preserves legitimate canonical query ordering without broadening the endpoint', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const transport = vi.fn(async () => Response.json([]));
      const fetcher = new DeliveryGitHubCredentials(
        db,
        async () => credential(),
        transport,
      ).readOnlyFetcher(repository, ['main']);
      const reordered = `https://api.github.com/repos/${repository}/pulls?page=1&state=all&per_page=100`;
      expect((await fetcher(reordered, { method: 'GET' })).status).toBe(200);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('rejects write methods without resolving a credential or making an upstream call', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const resolve = vi.fn(async () => credential());
      const transport = vi.fn(async () => Response.json({}));
      const fetcher = new DeliveryGitHubCredentials(db, resolve, transport).readOnlyFetcher(
        repository,
        ['main'],
      );
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        await expect(fetcher(listing, { method })).rejects.toMatchObject({
          statusCode: 503,
        });
      }
      expect(resolve).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
