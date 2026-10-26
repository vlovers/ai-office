import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import {
  publishCommitAttestedDraftViaGitHub,
  reconcileCommitAttestedDraftViaGitHub,
} from '../src/server/delivery-publication-github-commit.js';

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
const approval = {
  operationKey: publicationKey(plan),
  headCommitSha: '1'.repeat(40),
  baseCommitSha: '2'.repeat(40),
};
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  number: 123,
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, sha: approval.headCommitSha, repo },
  base: { ref: 'main', sha: approval.baseCommitSha, repo },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const confirmation = { ...approval, action: 'create-draft-pr' as const };
const options = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => ({
  token: 'test-token',
  title: 'Reviewed draft',
  confirmation,
  fetcher,
});
function context(journal: DeliveryJournal) {
  return {
    journal,
    workspaceId: 'workspace-1',
    repository: { path: '/repo', gitDir: '/repo/.git' },
    workspaceGitDir: '/repo/worktree/.git',
    plan,
    refreshPlan: async () => plan,
    approval,
  };
}
function mockGitHub() {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return json(receipt, 201);
    if (url.includes('/git/ref/heads/')) {
      const branch = url.endsWith('/main') ? 'main' : plan.branch;
      const sha = branch === 'main' ? approval.baseCommitSha : approval.headCommitSha;
      return json({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha } });
    }
    if (url.includes('/pulls?')) return json([receipt]);
    if (url.endsWith('/pulls/123')) return json(receipt);
    throw new Error('Unexpected request');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
});

describe('commit-pinned GitHub publication adapter', () => {
  it('performs head/base/head GET attestations then one POST and reuses its receipt', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = mockGitHub();
      const result = await publishCommitAttestedDraftViaGitHub(context(journal), options(fetcher));
      expect(result.state).toBe('published');
      expect(result.pullRequestUrl).toBe(receipt.html_url);
      expect(fetcher.mock.calls.map((call) => call[1].method)).toEqual([
        'GET',
        'GET',
        'GET',
        'POST',
      ]);
      await publishCommitAttestedDraftViaGitHub(context(journal), options(fetcher));
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      db.close();
    }
  });

  it('rejects invalid confirmation before reservation or network', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = mockGitHub();
      expect(() =>
        publishCommitAttestedDraftViaGitHub(context(journal), {
          ...options(fetcher),
          confirmation: { ...confirmation, operationKey: 'stale' },
        }),
      ).toThrow('confirmation');
      expect(fetcher).not.toHaveBeenCalled();
      expect(journal.get('workspace-1')).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('ambiguous GitHub publication outcomes', () => {
  it('preserves uncertainty after timeout and recovers using GET-only evidence', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = mockGitHub();
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('network timeout');
        return original(url, init);
      });
      const ctx = context(journal);
      await expect(publishCommitAttestedDraftViaGitHub(ctx, options(fetcher))).rejects.toThrow(
        'network timeout',
      );
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      await expect(publishCommitAttestedDraftViaGitHub(ctx, options(fetcher))).rejects.toThrow(
        'uncertain',
      );
      expect(fetcher).toHaveBeenCalledTimes(4);
      const recovered = await reconcileCommitAttestedDraftViaGitHub(ctx, {
        fetcher,
        token: 'test-token',
      });
      expect(recovered.state).toBe('published');
      expect(recovered.pullRequestUrl).toBe(receipt.html_url);
      expect(fetcher.mock.calls.map((call) => call[1].method)).toEqual([
        'GET',
        'GET',
        'GET',
        'POST',
        'GET',
        'GET',
      ]);
    } finally {
      db.close();
    }
  });

  it('leaves uncertain state on a stale GitHub commit receipt', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = mockGitHub();
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (url, init) =>
        init.method === 'POST'
          ? json({ ...receipt, head: { ...receipt.head, sha: '3'.repeat(40) } }, 201)
          : original(url, init),
      );
      await expect(
        publishCommitAttestedDraftViaGitHub(context(journal), options(fetcher)),
      ).rejects.toThrow('commit identity changed');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      db.close();
    }
  });

  it('refuses partial recovery and never issues a second POST', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-1', publicationKey(plan));
      journal.markUncertain('workspace-1', publicationKey(plan));
      const fetcher = vi.fn(async () => json({ message: 'rate limited' }, 429));
      await expect(
        reconcileCommitAttestedDraftViaGitHub(context(journal), { fetcher }),
      ).rejects.toThrow('HTTP 429');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
