import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import {
  publishApprovedDraft,
  publishCommitAttestedDraft,
  reconcileCommitAttestedDraft,
  reconcileUncertainDraft,
} from '../src/server/delivery-publication-service.js';

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

const headCommitSha = '1'.repeat(40);
const baseCommitSha = '2'.repeat(40);
const approvedCommits = {
  operationKey: publicationKey(plan),
  headCommitSha,
  baseCommitSha,
};
const commitReceipt = {
  ...candidate,
  head: { ...candidate.head, sha: headCommitSha },
  base: { ...candidate.base, sha: baseCommitSha },
};

function remoteRefs(headSha: string = headCommitSha, baseSha: string = baseCommitSha) {
  return vi.fn(async (input: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    const branch = input.endsWith('/main') ? 'main' : plan.branch;
    const sha = branch === 'main' ? baseSha : headSha;
    return new Response(
      JSON.stringify({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha } }),
      { status: 200 },
    );
  });
}

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

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
});

describe('lease-protected delivery publication pipeline', () => {
  it('reserves before POST and reuses the durable receipt without another POST', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const createDraft = vi.fn(async () => {
        expect(journal.get('workspace-1')?.state).toBe('reserved');
        return candidate;
      });
      const args = { ...context(journal), createDraft };
      const first = await publishApprovedDraft(args);
      const second = await publishApprovedDraft(args);
      expect(first.state).toBe('published');
      expect(second.pullRequestUrl).toBe(candidate.html_url);
      expect(createDraft).toHaveBeenCalledOnce();
      expect(acquireLocks).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('marks ambiguous API errors uncertain and prevents blind retry', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const createDraft = vi.fn().mockRejectedValue(new Error('socket closed'));
      const args = { ...context(journal), createDraft };
      await expect(publishApprovedDraft(args)).rejects.toThrow('socket closed');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      await expect(publishApprovedDraft(args)).rejects.toThrow('reconcile');
      expect(createDraft).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('rejects a forked GitHub response and preserves uncertain state', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const createDraft = vi.fn(async () => ({
        ...candidate,
        head: { ref: plan.branch, repo: { full_name: 'attacker/fork' } },
      }));
      await expect(publishApprovedDraft({ ...context(journal), createDraft })).rejects.toThrow(
        'does not match',
      );
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
    } finally {
      db.close();
    }
  });

  it('blocks changed review before reservation or remote writes', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const createDraft = vi.fn(async () => candidate);
      await expect(
        publishApprovedDraft({
          ...context(journal),
          refreshPlan: async () => ({ ...plan, revision: 'b'.repeat(64) }),
          createDraft,
        }),
      ).rejects.toThrow('snapshot changed');
      expect(createDraft).not.toHaveBeenCalled();
      expect(journal.get('workspace-1')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('blocks a different publication operation for the same workspace', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-1', 'other-operation');
      const createDraft = vi.fn(async () => candidate);
      await expect(publishApprovedDraft({ ...context(journal), createDraft })).rejects.toThrow(
        'different publication operation',
      );
      expect(createDraft).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('allows only one concurrent POST for a workspace', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      let release!: () => void;
      const remoteGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const createDraft = vi.fn(async () => {
        await remoteGate;
        return candidate;
      });
      const args = { ...context(journal), createDraft };
      const first = publishApprovedDraft(args);
      // Wait for the durable reservation and the in-flight remote POST.
      await vi.waitFor(() => expect(createDraft).toHaveBeenCalledOnce());
      expect(journal.get('workspace-1')?.state).toBe('reserved');
      // The second caller must be refused while the first POST is unresolved.
      const second = publishApprovedDraft(args);
      await expect(second).rejects.toThrow('reconcile before retrying');
      expect(createDraft).toHaveBeenCalledOnce();
      release();
      const published = await first;
      expect(published.state).toBe('published');
      const reused = await publishApprovedDraft(args);
      expect(reused.pullRequestUrl).toBe(candidate.html_url);
      expect(createDraft).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('reconciles a timeout from a complete read-only GitHub listing', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const createDraft = vi.fn().mockRejectedValue(new Error('timeout'));
      await expect(publishApprovedDraft({ ...context(journal), createDraft })).rejects.toThrow(
        'timeout',
      );
      const listAllRemoteDrafts = vi.fn(async () => ({
        complete: true,
        candidates: [candidate],
      }));
      const recovered = await reconcileUncertainDraft({
        ...context(journal),
        listAllRemoteDrafts,
      });
      expect(recovered.state).toBe('published');
      expect(recovered.pullRequestUrl).toBe(candidate.html_url);
      expect(createDraft).toHaveBeenCalledOnce();
      expect(listAllRemoteDrafts).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('refuses incomplete, missing, duplicate, closed and forked remote evidence', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const args = { ...context(journal) };
      await expect(
        publishApprovedDraft({
          ...args,
          createDraft: async () => {
            throw new Error('timeout');
          },
        }),
      ).rejects.toThrow('timeout');
      const snapshots = [
        { complete: false, candidates: [candidate] },
        { complete: true, candidates: [] },
        { complete: true, candidates: [candidate, candidate] },
        { complete: true, candidates: [{ ...candidate, state: 'closed' }] },
        {
          complete: true,
          candidates: [
            {
              ...candidate,
              head: { ref: plan.branch, repo: { full_name: 'attacker/fork' } },
            },
          ],
        },
      ];
      for (const snapshot of snapshots) {
        await expect(
          reconcileUncertainDraft({
            ...args,
            listAllRemoteDrafts: async () => snapshot,
          }),
        ).rejects.toThrow();
        expect(journal.get('workspace-1')?.state).toBe('uncertain');
      }
    } finally {
      db.close();
    }
  });

  it('recovers an interrupted reservation across SQLite reopen and confirms it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-delivery-'));
    const file = join(directory, 'journal.sqlite');
    try {
      const firstDb = new DatabaseSync(file);
      const firstJournal = new DeliveryJournal(firstDb);
      const { publicationKey } = await import('../src/server/delivery-publication-idempotency.js');
      firstJournal.reserve('workspace-1', publicationKey(plan));
      firstDb.close();

      const reopened = new DatabaseSync(file);
      try {
        const journal = new DeliveryJournal(reopened);
        journal.recoverInterrupted();
        expect(journal.get('workspace-1')?.state).toBe('uncertain');
        const result = await reconcileUncertainDraft({
          ...context(journal),
          listAllRemoteDrafts: async () => ({
            complete: true,
            candidates: [candidate],
          }),
        });
        expect(result.state).toBe('published');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('commit-attested publication pins both remote refs before the single POST', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = remoteRefs();
      const createDraft = vi.fn(async () => {
        expect(journal.get('workspace-1')?.state).toBe('reserved');
        expect(fetcher).toHaveBeenCalledTimes(2);
        return commitReceipt;
      });
      const args = {
        ...context(journal),
        approval: approvedCommits,
        gitHubRefOptions: { fetcher },
        createDraft,
      };
      const first = await publishCommitAttestedDraft(args);
      expect(first.state).toBe('published');
      expect(first.pullRequestUrl).toBe(candidate.html_url);
      const reused = await publishCommitAttestedDraft(args);
      expect(reused.pullRequestUrl).toBe(candidate.html_url);
      expect(createDraft).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('commit-attested publication blocks stale head before journal reservation', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = remoteRefs('3'.repeat(40));
      const createDraft = vi.fn(async () => commitReceipt);
      await expect(
        publishCommitAttestedDraft({
          ...context(journal),
          approval: approvedCommits,
          gitHubRefOptions: { fetcher },
          createDraft,
        }),
      ).rejects.toThrow('head branch moved');
      expect(journal.get('workspace-1')).toBeNull();
      expect(createDraft).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('commit-attested publication blocks stale base before journal reservation', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = remoteRefs(headCommitSha, '4'.repeat(40));
      const createDraft = vi.fn(async () => commitReceipt);
      await expect(
        publishCommitAttestedDraft({
          ...context(journal),
          approval: approvedCommits,
          gitHubRefOptions: { fetcher },
          createDraft,
        }),
      ).rejects.toThrow('base branch moved');
      expect(journal.get('workspace-1')).toBeNull();
      expect(createDraft).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('commit-attested publication marks a changed PR commit uncertain without retry', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = remoteRefs();
      const createDraft = vi.fn(async () => ({
        ...commitReceipt,
        head: { ...commitReceipt.head, sha: '5'.repeat(40) },
      }));
      const args = {
        ...context(journal),
        approval: approvedCommits,
        gitHubRefOptions: { fetcher },
        createDraft,
      };
      await expect(publishCommitAttestedDraft(args)).rejects.toThrow('commit identity changed');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      await expect(publishCommitAttestedDraft(args)).rejects.toThrow('reconcile before retrying');
      expect(createDraft).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('commit-attested publication blocks GitHub GET errors before reservation', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = vi.fn(async () => new Response('unavailable', { status: 429 }));
      const createDraft = vi.fn(async () => commitReceipt);
      await expect(
        publishCommitAttestedDraft({
          ...context(journal),
          approval: approvedCommits,
          gitHubRefOptions: { fetcher },
          createDraft,
        }),
      ).rejects.toThrow('HTTP 429');
      expect(journal.get('workspace-1')).toBeNull();
      expect(createDraft).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('commit-attested publication refuses changed review and approval before any GET', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const fetcher = remoteRefs();
      const createDraft = vi.fn(async () => commitReceipt);
      const args = {
        ...context(journal),
        approval: approvedCommits,
        gitHubRefOptions: { fetcher },
        createDraft,
      };
      await expect(
        publishCommitAttestedDraft({
          ...args,
          refreshPlan: async () => ({ ...plan, revision: 'b'.repeat(64) }),
        }),
      ).rejects.toThrow('snapshot changed');
      await expect(
        publishCommitAttestedDraft({
          ...args,
          approval: { ...approvedCommits, operationKey: 'not-reviewed' },
        }),
      ).rejects.toThrow('Approved commit snapshot');
      expect(fetcher).not.toHaveBeenCalled();
      expect(createDraft).not.toHaveBeenCalled();
      expect(journal.get('workspace-1')).toBeNull();
    } finally {
      db.close();
    }
  });
  it('commit-pinned timeout recovery confirms only a fresh PR detail with exact SHAs', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const createDraft = vi.fn().mockRejectedValue(new Error('POST timed out'));
      await expect(
        publishCommitAttestedDraft({
          ...context(journal),
          approval: approvedCommits,
          gitHubRefOptions: { fetcher: remoteRefs() },
          createDraft,
        }),
      ).rejects.toThrow('POST timed out');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
      const detailFetcher = vi.fn(async (input: string, init: RequestInit) => {
        expect(input).toBe('https://api.github.com/repos/vlovers/ai-office/pulls/123');
        expect(init.method).toBe('GET');
        expect(init.redirect).toBe('error');
        return new Response(JSON.stringify({ ...commitReceipt, number: 123 }), { status: 200 });
      });
      const recovered = await reconcileCommitAttestedDraft({
        ...context(journal),
        approval: approvedCommits,
        gitHubRefOptions: { fetcher: detailFetcher },
        listAllRemoteDrafts: async () => ({ complete: true, candidates: [candidate] }),
      });
      expect(recovered.state).toBe('published');
      expect(recovered.pullRequestUrl).toBe(candidate.html_url);
      expect(createDraft).toHaveBeenCalledOnce();
      expect(detailFetcher).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('commit-pinned recovery refuses changed or missing PR SHAs and remains uncertain', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      await expect(
        publishCommitAttestedDraft({
          ...context(journal),
          approval: approvedCommits,
          gitHubRefOptions: { fetcher: remoteRefs() },
          createDraft: async () => {
            throw new Error('timeout');
          },
        }),
      ).rejects.toThrow('timeout');
      for (const detail of [
        { ...commitReceipt, number: 123, head: { ...commitReceipt.head, sha: '3'.repeat(40) } },
        { ...candidate, number: 123 },
        { ...commitReceipt, number: 124 },
      ]) {
        const detailFetcher = vi.fn(async () =>
          new Response(JSON.stringify(detail), { status: 200 }),
        );
        await expect(
          reconcileCommitAttestedDraft({
            ...context(journal),
            approval: approvedCommits,
            gitHubRefOptions: { fetcher: detailFetcher },
            listAllRemoteDrafts: async () => ({ complete: true, candidates: [candidate] }),
          }),
        ).rejects.toThrow();
        expect(journal.get('workspace-1')?.state).toBe('uncertain');
      }
    } finally {
      db.close();
    }
  });

  it('commit-pinned recovery rejects duplicate/incomplete listing without a PR detail GET', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      await expect(
        publishCommitAttestedDraft({
          ...context(journal),
          approval: approvedCommits,
          gitHubRefOptions: { fetcher: remoteRefs() },
          createDraft: async () => {
            throw new Error('timeout');
          },
        }),
      ).rejects.toThrow('timeout');
      const detailFetcher = vi.fn();
      for (const snapshot of [
        { complete: false, candidates: [candidate] },
        { complete: true, candidates: [candidate, candidate] },
        { complete: true, candidates: [] },
      ]) {
        await expect(
          reconcileCommitAttestedDraft({
            ...context(journal),
            approval: approvedCommits,
            gitHubRefOptions: { fetcher: detailFetcher },
            listAllRemoteDrafts: async () => snapshot,
          }),
        ).rejects.toThrow();
      }
      expect(detailFetcher).not.toHaveBeenCalled();
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
    } finally {
      db.close();
    }
  });

});
