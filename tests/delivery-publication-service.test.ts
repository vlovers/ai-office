import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import {
  publishApprovedDraft,
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
      await expect(
        publishApprovedDraft({ ...context(journal), createDraft }),
      ).rejects.toThrow('does not match');
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
      await expect(
        publishApprovedDraft({ ...context(journal), createDraft }),
      ).rejects.toThrow('different publication operation');
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
      await expect(
        publishApprovedDraft({ ...context(journal), createDraft }),
      ).rejects.toThrow('timeout');
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
      const { publicationKey } = await import(
        '../src/server/delivery-publication-idempotency.js'
      );
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
});
