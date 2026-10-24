import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createApprovedDraftPublication } from '../src/server/delivery-approved-draft-publication.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import type { CompleteRemotePrInventory } from '../src/server/delivery-draft-pr-orchestration.js';
import type { GitHubDraftReceipt } from '../src/server/delivery-publication-receipt.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const binding = {
  workspaceId: 'workspace-approved',
  operator: { operatorId: 'operator-1', sessionId: 'session-1' },
  plan,
  commits: {
    operationKey: publicationKey(plan),
    headCommitSha: '1'.repeat(40),
    baseCommitSha: '2'.repeat(40),
  },
};
const receipt: GitHubDraftReceipt = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, repo: { full_name: 'vlovers/ai-office' } },
  base: { ref: 'main', repo: { full_name: 'vlovers/ai-office' } },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-approved-draft-'));
  const repositoryPath = join(root, 'repository');
  execFileSync('git', ['init', '-q', repositoryPath]);
  const repository = { path: repositoryPath, gitDir: realpathSync(join(repositoryPath, '.git')) };
  const dbPath = join(root, 'delivery.sqlite');
  let db = new DatabaseSync(dbPath);
  const createDraft = vi.fn(async () => receipt);
  const listRemote = vi.fn(async (): Promise<CompleteRemotePrInventory> => ({
    complete: true,
    candidates: [],
  }));
  const verifyApprovedSnapshot = vi.fn(async () => {});
  const authorizeBeforeReserve = vi.fn(() => {});
  const approvals = new DeliveryPublicationApprovalLedger(db, () => 10_000);
  const approvalId = approvals.issue(binding);
  const context = () => ({
    db,
    approvalId,
    binding,
    workspaceId: binding.workspaceId,
    repository,
    workspaceGitDir: repository.gitDir,
    initialPlan: plan,
    refreshPlan: async () => plan,
    verifyApprovedSnapshot,
    authorizeBeforeReserve,
    listRemote,
    createDraft,
    now: () => 10_000,
  });
  return {
    context,
    createDraft,
    listRemote,
    verifyApprovedSnapshot,
    authorizeBeforeReserve,
    approvals,
    journal: () => new DeliveryJournal(db),
    restart: () => {
      db.close();
      db = new DatabaseSync(dbPath);
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('approved Draft PR publication end-to-end boundary', () => {
  it('requires fresh authorization before reusing an already published receipt', async () => {
    const t = setup();
    try {
      expect((await createApprovedDraftPublication(t.context())).status).toBe('published');
      t.authorizeBeforeReserve.mockImplementationOnce(() => {
        throw new Error('session revoked after publication');
      });
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow(
        'session revoked after publication',
      );
      expect(t.createDraft).toHaveBeenCalledTimes(1);
      expect(t.journal().get(binding.workspaceId)?.state).toBe('published');
    } finally {
      t.close();
    }
  });

  it('rejects asynchronous authorization before any remote inventory request', async () => {
    const t = setup();
    try {
      t.authorizeBeforeReserve.mockImplementationOnce((() => Promise.resolve()) as () => void);
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow('synchronous');
      expect(t.listRemote).not.toHaveBeenCalled();
      expect(t.createDraft).not.toHaveBeenCalled();
      expect(t.journal().get(binding.workspaceId)).toBeNull();
    } finally {
      t.close();
    }
  });

  it('consumes one approval, publishes once and reuses the receipt after restart', async () => {
    const t = setup();
    try {
      expect((await createApprovedDraftPublication(t.context())).status).toBe('published');
      expect(() => t.approvals.assertPending(t.context().approvalId, binding)).toThrow();
      t.restart();
      expect((await createApprovedDraftPublication(t.context())).status).toBe('published');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
      expect(t.journal().get(binding.workspaceId)?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.authorizeBeforeReserve).toHaveBeenCalledTimes(3);
    } finally {
      t.close();
    }
  });

  it('reconciles an ambiguous GitHub write after restart without replay', async () => {
    const t = setup();
    try {
      t.createDraft.mockRejectedValueOnce(new Error('GitHub response lost'));
      expect((await createApprovedDraftPublication(t.context())).status).toBe('uncertain');
      t.restart();
      t.listRemote.mockResolvedValueOnce({ complete: false, reason: 'page missing' });
      expect((await createApprovedDraftPublication(t.context())).status).toBe('uncertain');
      expect(t.journal().get(binding.workspaceId)?.state).toBe('uncertain');
      t.listRemote.mockResolvedValueOnce({ complete: true, candidates: [receipt] });
      expect((await createApprovedDraftPublication(t.context())).status).toBe('published');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
      expect(t.authorizeBeforeReserve).toHaveBeenCalledTimes(4);
    } finally {
      t.close();
    }
  });

  it('fails closed when live operator authorization is revoked', async () => {
    const t = setup();
    try {
      t.authorizeBeforeReserve.mockImplementationOnce(() => {
        throw new Error('operator revoked');
      });
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow('operator revoked');
      expect(t.journal().get(binding.workspaceId)).toBeNull();
      t.approvals.assertPending(t.context().approvalId, binding);
      expect(t.createDraft).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects stale plan, foreign binding and failed snapshot', async () => {
    const t = setup();
    try {
      await expect(
        createApprovedDraftPublication({
          ...t.context(),
          workspaceId: 'foreign-workspace',
        }),
      ).rejects.toThrow('differs');
      await expect(
        createApprovedDraftPublication({
          ...t.context(),
          refreshPlan: async () => ({ ...plan, revision: 'b'.repeat(64) }),
        }),
      ).rejects.toThrow();
      t.verifyApprovedSnapshot.mockRejectedValueOnce(new Error('stale reviewed head'));
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow(
        'stale reviewed head',
      );
      t.approvals.assertPending(t.context().approvalId, binding);
      expect(t.journal().get(binding.workspaceId)).toBeNull();
      expect(t.createDraft).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('blocks incomplete remote inventory and duplicate PR before consuming approval', async () => {
    const t = setup();
    try {
      t.listRemote.mockResolvedValueOnce({ complete: false, reason: 'GitHub 502' });
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow('incomplete');
      t.listRemote.mockResolvedValueOnce({ complete: true, candidates: [receipt] });
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow(
        'without local journal',
      );
      t.approvals.assertPending(t.context().approvalId, binding);
      expect(t.journal().get(binding.workspaceId)).toBeNull();
      expect(t.createDraft).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('fails closed on a competing request while the shared repository lease is held', async () => {
    const t = setup();
    let releaseGate = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    t.verifyApprovedSnapshot.mockImplementationOnce(async () => {
      signalEntered();
      await gate;
    });
    try {
      const first = createApprovedDraftPublication(t.context());
      await entered;
      await expect(createApprovedDraftPublication(t.context())).rejects.toThrow('locked');
      releaseGate();
      expect((await first).status).toBe('published');
      expect((await createApprovedDraftPublication(t.context())).status).toBe('published');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
      expect(t.authorizeBeforeReserve).toHaveBeenCalledTimes(4);
    } finally {
      releaseGate();
      t.close();
    }
  });

  it('keeps uncertain state for malformed GitHub receipts without retry', async () => {
    const t = setup();
    try {
      t.createDraft.mockResolvedValueOnce({ ...receipt, draft: false });
      expect((await createApprovedDraftPublication(t.context())).status).toBe('uncertain');
      expect(t.journal().get(binding.workspaceId)?.state).toBe('uncertain');
      t.listRemote.mockResolvedValueOnce({ complete: false, reason: 'unknown' });
      expect((await createApprovedDraftPublication(t.context())).status).toBe('uncertain');
      expect(t.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      t.close();
    }
  });
});
