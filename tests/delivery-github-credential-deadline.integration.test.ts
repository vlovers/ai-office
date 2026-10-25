import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DeliveryGitHubCredentials,
  type DeliveryReadCredential,
} from '../src/server/delivery-github-credentials.js';

const repository = 'vlovers/ai-office';
const endpoint = `https://api.github.com/repos/${repository}/git/ref/heads/main`;
const token = `github_pat_TEST_${'A'.repeat(25)}`;

function credential(): DeliveryReadCredential {
  return {
    id: 'deadline-test-version',
    token,
    repository,
    expiresAt: 60_000,
    permissions: { contents: 'read', pullRequests: 'read' },
  };
}

function manager(
  db: DatabaseSync,
  resolve: () => Promise<DeliveryReadCredential>,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
): DeliveryGitHubCredentials {
  return new DeliveryGitHubCredentials(db, resolve, fetcher, () => 1000, 100);
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('credential-scoped GitHub deadline and live authorization', () => {
  it('bounds a stalled credential provider and ignores its late result without changing SQLite', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let resolveCredential!: (value: DeliveryReadCredential) => void;
      let transportCalls = 0;
      const vault = manager(
        db,
        () =>
          new Promise<DeliveryReadCredential>((resolve) => {
            resolveCredential = resolve;
          }),
        async () => {
          transportCalls++;
          return Response.json({});
        },
      );
      await expect(vault.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' })).rejects.toMatchObject({
        statusCode: 503,
      });
      resolveCredential(credential());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transportCalls).toBe(0);
      expect(count(db, 'delivery_credential_clock')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('bounds a fetcher that ignores abort and discards a late HTTP 401 without a journal write', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let finish!: (response: Response) => void;
      const vault = manager(
        db,
        async () => credential(),
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      await expect(vault.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' })).rejects.toMatchObject({
        statusCode: 503,
      });
      finish(new Response(null, { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(count(db, 'delivery_revoked_credentials')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('bounds a response body that never finishes, even if the transport returns HTTP 200', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const vault = manager(
        db,
        async () => credential(),
        async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
      );
      await expect(vault.readOnlyFetcher(repository, ['main'])(endpoint, { method: 'GET' })).rejects.toMatchObject({
        statusCode: 503,
      });
    } finally {
      db.close();
    }
  });

  it('honors caller cancellation while the vault ignores abort, without touching SQLite', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let finish!: (value: DeliveryReadCredential) => void;
      const controller = new AbortController();
      const vault = manager(
        db,
        () =>
          new Promise<DeliveryReadCredential>((resolve) => {
            finish = resolve;
          }),
        async () => Response.json({}),
      );
      const pending = vault.readOnlyFetcher(repository, ['main'])(endpoint, {
        method: 'GET',
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ statusCode: 503 });
      finish(credential());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(count(db, 'delivery_credential_clock')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects asynchronous authorization hooks before any upstream request', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let calls = 0;
      const vault = manager(
        db,
        async () => credential(),
        async () => {
          calls++;
          return Response.json({});
        },
      );
      const asynchronous = (() => Promise.resolve()) as unknown as () => void;
      await expect(
        vault.readOnlyFetcher(repository, ['main'], asynchronous)(endpoint, { method: 'GET' }),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects an operator grant revoked while the upstream GET is in flight', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let allowed = true;
      let checks = 0;
      const vault = manager(
        db,
        async () => credential(),
        async () => {
          allowed = false;
          return Response.json({ ref: 'refs/heads/main' });
        },
      );
      const authorize = () => {
        checks++;
        if (!allowed) throw new Error('grant revoked');
      };
      await expect(
        vault.readOnlyFetcher(repository, ['main'], authorize)(endpoint, { method: 'GET' }),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(checks).toBe(2);
    } finally {
      db.close();
    }
  });

  it('rejects an operator grant revoked during response-body streaming', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let allowed = true;
      const vault = manager(
        db,
        async () => credential(),
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                allowed = false;
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
              },
            }),
          ),
      );
      await expect(
        vault.readOnlyFetcher(repository, ['main'], () => {
          if (!allowed) throw new Error('grant revoked');
        })(endpoint, { method: 'GET' }),
      ).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      db.close();
    }
  });

  it('allows a valid response only after two synchronous live-grant checks', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      let checks = 0;
      const vault = manager(
        db,
        async () => credential(),
        async () => Response.json({ ref: 'refs/heads/main' }),
      );
      const response = await vault.readOnlyFetcher(repository, ['main'], () => {
        checks++;
      })(endpoint, { method: 'GET' });
      expect(await response.json()).toEqual({ ref: 'refs/heads/main' });
      expect(checks).toBe(2);
    } finally {
      db.close();
    }
  });
});
