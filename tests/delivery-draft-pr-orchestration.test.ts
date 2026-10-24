import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import {
  createDraftPublication,
  type CompleteRemotePrInventory,
} from '../src/server/delivery-draft-pr-orchestration.js';
import type { GitHubDraftReceipt } from '../src/server/delivery-publication-receipt.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const receipt: GitHubDraftReceipt = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, repo: { full_name: 'vlovers/ai-office' } },
  base: { ref: 'main', repo: { full_name: 'vlovers/ai-office' } },
};

function setup() {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'ai-office-draft-pr-'));
  execFileSync('git', ['init', '-q', root]);
  const repository = { path: root, gitDir: realpathSync(join(root, '.git')) };
  const journal = new DeliveryJournal(db);
  const createDraft = vi.fn(async () => receipt);
  const listRemote = vi.fn(async (): Promise<CompleteRemotePrInventory> => ({
    complete: true,
    candidates: [],
  }));
  const verifySnapshot = vi.fn(async () => {});
  const context = {
    workspaceId: 'workspace-1',
    repository,
    workspaceGitDir: repository.gitDir,
    journal,
    initialPlan: plan,
    refreshPlan: async () => plan,
    verifySnapshot,
    listRemote,
    createDraft,
  };
  return {
    db,
    journal,
    context,
    createDraft,
    listRemote,
    verifySnapshot,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Draft PR publication orchestration', () => {
  it('publishes once, reuses durable receipt and never repeats remote creation', async () => {
    const t = setup();
    try {
      expect((await createDraftPublication(t.context)).status).toBe('published');
      expect((await createDraftPublication(t.context)).status).toBe('published');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
    } finally {
      t.close();
    }
  });

  it('never retries an ambiguous API failure; reconciles a verified remote receipt', async () => {
    const t = setup();
    try {
      t.createDraft.mockRejectedValueOnce(new Error('HTTP timeout'));
      expect((await createDraftPublication(t.context)).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      t.listRemote.mockResolvedValueOnce({ complete: true, candidates: [receipt] });
      expect((await createDraftPublication(t.context)).status).toBe('published');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      t.close();
    }
  });

  it('fails closed on incomplete inventory, duplicate PR and mismatched receipt', async () => {
    const t = setup();
    try {
      t.listRemote.mockResolvedValueOnce({ complete: false, reason: 'page 2 failed' });
      await expect(createDraftPublication(t.context)).rejects.toThrow('incomplete');
      expect(t.journal.get('workspace-1')).toBeNull();
      t.listRemote.mockResolvedValueOnce({ complete: true, candidates: [receipt] });
      await expect(createDraftPublication(t.context)).rejects.toThrow('without local journal');
      t.createDraft.mockResolvedValueOnce({ ...receipt, draft: false });
      expect((await createDraftPublication(t.context)).status).toBe('uncertain');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      t.close();
    }
  });

  it('blocks failed remote preflight without reserving or publishing', async () => {
    const t = setup();
    try {
      t.listRemote.mockRejectedValueOnce(new Error('GitHub 502: internal details'));
      await expect(createDraftPublication(t.context)).rejects.toThrow('Remote PR inventory failed');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.createDraft).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('keeps uncertain state on incomplete recovery and never recreates the PR', async () => {
    const t = setup();
    try {
      t.createDraft.mockRejectedValueOnce(new Error('connection reset'));
      expect((await createDraftPublication(t.context)).status).toBe('uncertain');
      t.listRemote.mockResolvedValueOnce({ complete: false, reason: 'page 3 timed out' });
      expect((await createDraftPublication(t.context)).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      t.close();
    }
  });

  it('rejects malformed GitHub inventory before reserving any durable intent', async () => {
    const t = setup();
    try {
      t.listRemote.mockResolvedValueOnce({
        complete: true,
        candidates: [null],
      } as unknown as CompleteRemotePrInventory);
      await expect(createDraftPublication(t.context)).rejects.toThrow('incomplete or invalid');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.createDraft).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('blocks managed head branch reuse even when the existing PR targets another base', async () => {
    const t = setup();
    try {
      t.listRemote.mockResolvedValueOnce({
        complete: true,
        candidates: [{ ...receipt, base: { ...receipt.base, ref: 'release' } }],
      });
      await expect(createDraftPublication(t.context)).rejects.toThrow('head branch conflict');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.createDraft).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('preserves an uncertain outcome when recovery receives malformed inventory', async () => {
    const t = setup();
    try {
      t.createDraft.mockRejectedValueOnce(new Error('network disconnected'));
      expect((await createDraftPublication(t.context)).status).toBe('uncertain');
      t.listRemote.mockResolvedValueOnce({
        complete: true,
        candidates: [{ ...receipt, head: null }],
      } as unknown as CompleteRemotePrInventory);
      const result = await createDraftPublication(t.context);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      t.close();
    }
  });

  it('reconciles a persisted uncertain intent after SQLite and process-context restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-office-restart-'));
    const repoPath = join(root, 'repo');
    const databasePath = join(root, 'delivery.sqlite');
    execFileSync('git', ['init', '-q', repoPath]);
    const repository = { path: repoPath, gitDir: realpathSync(join(repoPath, '.git')) };
    let db = new DatabaseSync(databasePath);
    const createDraft = vi.fn(async (): Promise<GitHubDraftReceipt> => {
      throw new Error('remote write response lost');
    });
    const context = {
      workspaceId: 'workspace-restarted',
      repository,
      workspaceGitDir: repository.gitDir,
      journal: new DeliveryJournal(db),
      initialPlan: plan,
      refreshPlan: async () => plan,
      verifySnapshot: async () => {},
      listRemote: async (): Promise<CompleteRemotePrInventory> => ({
        complete: true,
        candidates: [],
      }),
      createDraft,
    };
    try {
      expect((await createDraftPublication(context)).status).toBe('uncertain');
      db.close();
      db = new DatabaseSync(databasePath);
      const restartedContext = {
        ...context,
        journal: new DeliveryJournal(db),
        listRemote: async (): Promise<CompleteRemotePrInventory> => ({
          complete: true,
          candidates: [receipt],
        }),
      };
      expect((await createDraftPublication(restartedContext)).status).toBe('published');
      expect(restartedContext.journal.get('workspace-restarted')?.pullRequestUrl).toBe(
        receipt.html_url,
      );
      expect(createDraft).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a competing publication while the shared repository lease is held', async () => {
    const t = setup();
    let releaseDraft: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    try {
      t.createDraft.mockImplementationOnce(async () => {
        await gate;
        return receipt;
      });
      const first = createDraftPublication(t.context);
      await vi.waitFor(() => expect(t.createDraft).toHaveBeenCalledTimes(1));
      await expect(createDraftPublication(t.context)).rejects.toThrow('Resource is locked');
      releaseDraft?.();
      expect((await first).status).toBe('published');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      releaseDraft?.();
      t.close();
    }
  });

  it('blocks changed review snapshots before touching the journal or remote API', async () => {
    const t = setup();
    try {
      await expect(
        createDraftPublication({
          ...t.context,
          refreshPlan: async () => ({ ...plan, revision: 'b'.repeat(64) }),
        }),
      ).rejects.toThrow('snapshot changed');
      expect(t.createDraft).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });
});
