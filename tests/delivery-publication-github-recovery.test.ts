import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { reconcileUncertainDraftViaGitHub } from '../src/server/delivery-publication-github-recovery.js';

const { acquireLocks, repositoryLeaseDirectories } = vi.hoisted(() => ({
  acquireLocks: vi.fn(),
  repositoryLeaseDirectories: vi.fn(),
}));
vi.mock('../src/server/lock.js', () => ({ acquireLocks }));
vi.mock('../src/server/repositories.js', () => ({ repositoryLeaseDirectories }));

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const repo = { full_name: 'vlovers/ai-office' };
const candidate = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, repo },
  base: { ref: 'main', repo },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function context(journal: DeliveryJournal) {
  return {
    journal,
    workspaceId: 'workspace-1',
    repository: { path: '/repo', gitDir: '/repo/.git' },
    workspaceGitDir: '/repo/worktree/.git',
    plan,
    refreshPlan: async () => plan,
  };
}

function uncertainJournal(db: DatabaseSync) {
  const journal = new DeliveryJournal(db);
  journal.reserve('workspace-1', publicationKey(plan));
  journal.markUncertain('workspace-1', publicationKey(plan));
  return journal;
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
});

describe('lease-protected GitHub GET reconciliation', () => {
  it('confirms one verified draft and never performs a remote write', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = uncertainJournal(db);
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe('GET');
        return json([candidate]);
      });
      const args = { ...context(journal) };
      const result = await reconcileUncertainDraftViaGitHub(args, { fetcher });
      expect(result.state).toBe('published');
      expect(result.pullRequestUrl).toBe(candidate.html_url);
      expect(fetcher).toHaveBeenCalledOnce();
      await expect(reconcileUncertainDraftViaGitHub(args, { fetcher })).rejects.toThrow(
        'matching uncertain',
      );
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('reconciles a crashed reservation through GET and blocks a second publication', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-1', publicationKey(plan));
      expect(journal.get('workspace-1')?.state).toBe('reserved');
      journal.recoverWorkspace('workspace-1', publicationKey(plan));
      expect(journal.get('workspace-1')?.state).toBe('uncertain');

      const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe('GET');
        return json([candidate]);
      });
      const result = await reconcileUncertainDraftViaGitHub(context(journal), { fetcher });
      expect(result.state).toBe('published');
      expect(result.pullRequestUrl).toBe(candidate.html_url);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(() => journal.reserve('workspace-1', publicationKey(plan))).toThrow('already exists');
    } finally {
      db.close();
    }
  });

  it('keeps uncertain state after a failed later page', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = uncertainJournal(db);
      const fetcher = vi.fn(async (url: string) => {
        const page = new URL(url).searchParams.get('page');
        return page === '1'
          ? json([
              candidate,
              {
                ...candidate,
                html_url: 'https://github.com/vlovers/ai-office/pull/124',
                head: { ...candidate.head, ref: 'unrelated-branch' },
              },
            ])
          : json({ message: 'rate limit' }, 429);
      });
      await expect(
        reconcileUncertainDraftViaGitHub(context(journal), { fetcher, perPage: 2 }),
      ).rejects.toThrow('HTTP 429');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('rejects stale review before contacting GitHub', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = uncertainJournal(db);
      const fetcher = vi.fn();
      await expect(
        reconcileUncertainDraftViaGitHub(
          {
            ...context(journal),
            refreshPlan: async () => ({ ...plan, revision: 'b'.repeat(64) }),
          },
          { fetcher },
        ),
      ).rejects.toThrow('snapshot changed');
      expect(fetcher).not.toHaveBeenCalled();
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
    } finally {
      db.close();
    }
  });

  it('refuses absent and forked PR evidence without retrying a write', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = uncertainJournal(db);
      const fetcher = vi.fn(async () => json([]));
      await expect(reconcileUncertainDraftViaGitHub(context(journal), { fetcher })).rejects.toThrow(
        'absence does not authorize retry',
      );
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      fetcher.mockImplementation(async () =>
        json([{ ...candidate, head: { ref: plan.branch, repo: { full_name: 'evil/fork' } } }]),
      );
      await expect(reconcileUncertainDraftViaGitHub(context(journal), { fetcher })).rejects.toThrow(
        'identity verification',
      );
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
    } finally {
      db.close();
    }
  });
});
