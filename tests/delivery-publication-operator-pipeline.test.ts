import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { publishOperatorAuthorizedDraftViaGitHub } from '../src/server/delivery-publication-github-commit.js';

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
const commits = {
  operationKey: publicationKey(plan),
  headCommitSha: '1'.repeat(40),
  baseCommitSha: '2'.repeat(40),
};
const operator = { operatorId: 'operator-1', sessionId: 'session-1' };
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  number: 123,
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, sha: commits.headCommitSha, repo },
  base: { ref: 'main', sha: commits.baseCommitSha, repo },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const confirmation = { ...commits, action: 'create-draft-pr' as const };

function setup() {
  const db = new DatabaseSync(':memory:');
  const journal = new DeliveryJournal(db);
  const ledger = new DeliveryPublicationApprovalLedger(db);
  const approvalId = ledger.issue({ workspaceId: 'workspace-1', operator, plan, commits });
  const context = {
    journal,
    workspaceId: 'workspace-1',
    repository: { path: '/repo', gitDir: '/repo/.git' },
    workspaceGitDir: '/repo/worktree/.git',
    plan,
    refreshPlan: async () => plan,
    approval: commits,
  };
  const authorization = { ledger, approvalId, operator };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return json(receipt, 201);
    if (url.includes('/git/ref/heads/')) {
      const branch = url.endsWith('/main') ? 'main' : plan.branch;
      return json({
        ref: `refs/heads/${branch}`,
        object: {
          type: 'commit',
          sha: branch === 'main' ? commits.baseCommitSha : commits.headCommitSha,
        },
      });
    }
    throw new Error('Unexpected GitHub request.');
  });
  const options = { token: 'test-token', title: 'Approved draft', confirmation, fetcher };
  return { db, journal, ledger, context, authorization, fetcher, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
});

describe('durable operator approval in the GitHub draft pipeline', () => {
  it('attests remote commits, consumes approval, reserves and sends exactly one POST', async () => {
    const t = setup();
    try {
      t.fetcher.mockImplementationOnce(async (url, init) => {
        expect(init.method).toBe('GET');
        t.ledger.assertPending(t.authorization.approvalId, {
          workspaceId: 'workspace-1',
          operator,
          plan,
          commits,
        });
        const branch = plan.branch;
        return json({
          ref: `refs/heads/${branch}`,
          object: { type: 'commit', sha: commits.headCommitSha },
        });
      });
      const result = await publishOperatorAuthorizedDraftViaGitHub(
        t.context,
        t.options,
        t.authorization,
      );
      expect(result.state).toBe('published');
      expect(t.fetcher.mock.calls.map((call) => call[1].method)).toEqual([
        'GET',
        'GET',
        'POST',
      ]);
      expect(() =>
        t.ledger.assertPending(t.authorization.approvalId, {
          workspaceId: 'workspace-1',
          operator,
          plan,
          commits,
        }),
      ).toThrow('no longer valid');
      expect(() =>
        publishOperatorAuthorizedDraftViaGitHub(t.context, t.options, t.authorization),
      ).toThrow();
      expect(t.fetcher).toHaveBeenCalledTimes(3);
    } finally {
      t.db.close();
    }
  });

  it('refuses wrong operator or session without GitHub GET or journal reservation', () => {
    const t = setup();
    try {
      for (const identity of [
        { operatorId: 'intruder', sessionId: 'session-1' },
        { operatorId: 'operator-1', sessionId: 'other-session' },
      ]) {
        expect(() =>
          publishOperatorAuthorizedDraftViaGitHub(t.context, t.options, {
            ...t.authorization,
            operator: identity,
          }),
        ).toThrow();
      }
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.db.close();
    }
  });

  it('preserves approval after a stale review or failed remote GET', async () => {
    const t = setup();
    try {
      await expect(
        publishOperatorAuthorizedDraftViaGitHub(
          {
            ...t.context,
            refreshPlan: async () => ({ ...plan, revision: 'b'.repeat(64) }),
          },
          t.options,
          t.authorization,
        ),
      ).rejects.toThrow('snapshot changed');
      expect(t.fetcher).not.toHaveBeenCalled();
      const failing = vi.fn(async () => json({ message: 'rate limited' }, 429));
      await expect(
        publishOperatorAuthorizedDraftViaGitHub(
          t.context,
          { ...t.options, fetcher: failing },
          t.authorization,
        ),
      ).rejects.toThrow('HTTP 429');
      t.ledger.assertPending(t.authorization.approvalId, {
        workspaceId: 'workspace-1',
        operator,
        plan,
        commits,
      });
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.db.close();
    }
  });

  it('consumes approval before ambiguous POST and never allows another POST', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          expect(t.journal.get('workspace-1')?.state).toBe('reserved');
          throw new Error('network timeout');
        }
        return original(url, init);
      });
      await expect(
        publishOperatorAuthorizedDraftViaGitHub(t.context, t.options, t.authorization),
      ).rejects.toThrow('network timeout');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(() =>
        publishOperatorAuthorizedDraftViaGitHub(t.context, t.options, t.authorization),
      ).toThrow();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.db.close();
    }
  });
});
