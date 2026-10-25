import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createSessionBoundGitHubDraft } from '../src/server/delivery-approved-github-publication.js';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { DeliverySessions } from '../src/server/delivery-sessions.js';

const { attestLocalReviewedGitState } = vi.hoisted(() => ({
  attestLocalReviewedGitState: vi.fn(async () => ({})),
}));
vi.mock('../src/server/delivery-local-git-attestation.js', () => ({
  attestLocalReviewedGitState,
}));

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main' as const,
  revision: 'a'.repeat(64),
  draft: true as const,
};
const headSha = '1'.repeat(40);
const baseSha = '2'.repeat(40);
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  number: 123,
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, sha: headSha, repo },
  base: { ref: 'main', sha: baseSha, repo },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function setup(options: { omitPush?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-session-draft-'));
  const path = join(root, 'repo');
  execFileSync('git', ['init', '-q', path]);
  const gitDir = realpathSync(join(path, '.git'));
  const dbPath = join(root, 'delivery.sqlite');
  const db = new DatabaseSync(dbPath);
  const sessions = new DeliverySessions(db, () => 10_000);
  sessions.setOperator('operator-1', true);
  sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', true);
  const ticket = sessions.issueEnrollment('operator-1');
  const { token } = sessions.exchangeEnrollment(ticket);
  const operator = sessions.authorize(token, 'workspace-1', 'approve:draft-pr');
  const workspace = {
    workspaceId: 'workspace-1',
    repository: { path, gitDir },
    worktree: { path, gitDir },
    plan,
    headSha,
    baseSha,
  };
  const commits = {
    operationKey: publicationKey(plan),
    headCommitSha: headSha,
    baseCommitSha: baseSha,
  };
  const approvals = new DeliveryPublicationApprovalLedger(db, () => 10_000);
  const approvalId = approvals.issue({
    workspaceId: 'workspace-1',
    operator,
    plan,
    commits,
  });
  const transfers = new DeliveryGitTransferJournal(db);
  const identity = {
    workspaceId: 'workspace-1',
    operationKey: commits.operationKey,
    destination: plan.destination,
    branch: plan.branch,
    headSha,
    baseSha,
  };
  for (const stage of ['commit', 'push'] as const) {
    if (options.omitPush && stage === 'push') continue;
    transfers.begin(stage, identity);
    transfers.confirmVerified(stage, identity, headSha);
  }
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'POST') return json(receipt, 201);
    if (url.includes('/git/ref/heads/')) {
      const branch = url.endsWith('/main') ? 'main' : plan.branch;
      return json({
        ref: 'refs/heads/' + branch,
        object: { type: 'commit', sha: branch === 'main' ? baseSha : headSha },
      });
    }
    if (url.includes('/pulls?')) return json([]);
    if (url.endsWith('/pulls/123')) return json(receipt);
    throw new Error('Unexpected GitHub request.');
  });
  const context = () => ({
    sessions,
    sessionToken: token,
    workspace,
    refreshWorkspace: async () => workspace,
    approvalId,
    write: { token: 'server-owned-write-token', title: 'Reviewed draft', fetcher },
  });
  return {
    db,
    dbPath,
    sessions,
    approvals,
    transfers,
    fetcher,
    context,
    journal: new DeliveryJournal(db),
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function interruptReservationTransaction(
  dbPath: string,
  approvalId: string,
  operationKey: string,
  committed: boolean,
) {
  // A separate Node process simulates the SQLite atomic boundary immediately
  // before or after COMMIT, then dies without running cleanup or GitHub I/O.
  const script = [
    "const {DatabaseSync}=require('node:sqlite');",
    'const db=new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    "const consumed=db.prepare('UPDATE delivery_publication_approvals SET consumed_at=10000 WHERE approval_id=? AND consumed_at IS NULL').run(process.argv[2]);",
    'if(consumed.changes!==1)process.exit(3);',
    "db.prepare(\"INSERT INTO delivery_journal (workspace_id, operation_key, state, pull_request_url) VALUES (?, ?, 'reserved', NULL)\").run('workspace-1', process.argv[3]);",
    "if(process.argv[4]==='commit')db.exec('COMMIT');",
    "process.kill(process.pid,'SIGKILL');",
  ].join(' ');
  const args = ['-e', script, dbPath, approvalId, operationKey, committed ? 'commit' : 'rollback'];
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
}

function approvalConsumedAt(db: DatabaseSync, approvalId: string) {
  return db
    .prepare('SELECT consumed_at FROM delivery_publication_approvals WHERE approval_id=?')
    .get(approvalId)?.consumed_at;
}

describe('session-bound approved GitHub Draft PR executor (server only)', () => {
  it('attests both refs, inventories PRs, atomically reserves and verifies detail after one POST', async () => {
    const t = setup();
    try {
      const result = await createSessionBoundGitHubDraft(t.context());
      expect(result.status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      expect(t.fetcher.mock.calls.some((call) => call[0].endsWith('/pulls/123'))).toBe(true);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('keeps confirmed Git transfers immutable across Draft publication and receipt reuse', async () => {
    const t = setup();
    try {
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.transfers.get('workspace-1', 'commit')?.state).toBe('confirmed');
      expect(t.transfers.get('workspace-1', 'push')?.state).toBe('confirmed');
      expect(() =>
        t.db
          .prepare(
            "UPDATE delivery_git_transfers SET state='uncertain' WHERE workspace_id='workspace-1' AND stage='push'",
          )
          .run(),
      ).toThrow();
      expect(() =>
        t.db
          .prepare(
            "DELETE FROM delivery_git_transfers WHERE workspace_id='workspace-1' AND stage='commit'",
          )
          .run(),
      ).toThrow();
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('rejects revoked session/grant before GitHub access or reservation', async () => {
    const t = setup();
    try {
      t.sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', false);
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('requires verified commit and push receipts before any GitHub call', async () => {
    const t = setup({ omitPush: true });
    try {
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('rejects a changed trusted registry snapshot without remote traffic', async () => {
    const t = setup();
    try {
      await expect(
        createSessionBoundGitHubDraft({
          ...t.context(),
          refreshWorkspace: async () => ({
            ...t.context().workspace,
            headSha: '3'.repeat(40),
          }),
        }),
      ).rejects.toThrow('changed since operator review');
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('does not consume approval or reserve on GitHub inventory 429', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) =>
        url.includes('/pulls?') ? json({ message: 'rate limited' }, 429) : original(url, init),
      );
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow('inventory failed');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('never repeats an ambiguous POST and requires independently verified PR detail', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('GitHub timeout');
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) return json([receipt]);
        if (url.endsWith('/pulls/123')) {
          return json({ ...receipt, head: { ...receipt.head, sha: '3'.repeat(40) } });
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) return json([receipt]);
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('re-attests local Git immediately before the single POST', async () => {
    const t = setup();
    try {
      const before = attestLocalReviewedGitState.mock.calls.length;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(attestLocalReviewedGitState.mock.calls.length - before).toBe(6);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('blocks POST if local Git drifts during the final remote ref GET', async () => {
    const t = setup();
    let dirty = false;
    try {
      attestLocalReviewedGitState.mockImplementation(async () => {
        if (dirty) throw new Error('Local Git changed after remote attestation.');
        return {};
      });
      const original = t.fetcher.getMockImplementation()!;
      let baseReads = 0;
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/git/ref/heads/main') && ++baseReads === 2) dirty = true;
        return original(url, init);
      });
      const result = await createSessionBoundGitHubDraft(t.context());
      expect(baseReads).toBe(2);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      dirty = false;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      attestLocalReviewedGitState.mockImplementation(async () => ({}));
      t.close();
    }
  });

  it('keeps a completed POST uncertain if local Git drifts during PR detail GET', async () => {
    const t = setup();
    let dirty = false;
    let mutateOnDetail = true;
    let posted = false;
    try {
      attestLocalReviewedGitState.mockImplementation(async () => {
        if (dirty) throw new Error('Local Git changed during PR detail GET.');
        return {};
      });
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') posted = true;
        if (url.includes('/pulls?') && posted) return json([receipt]);
        if (url.endsWith('/pulls/123') && mutateOnDetail) {
          dirty = true;
          mutateOnDetail = false;
        }
        return original(url, init);
      });
      const first = await createSessionBoundGitHubDraft(t.context());
      expect(first.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      dirty = false;
      const recovered = await createSessionBoundGitHubDraft(t.context());
      expect(recovered.status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      attestLocalReviewedGitState.mockImplementation(async () => ({}));
      t.close();
    }
  });

  it('does not confirm an ambiguous POST while Git drifts during recovery detail GET', async () => {
    const t = setup();
    let dirty = false;
    let posted = false;
    let mutateOnDetail = true;
    try {
      attestLocalReviewedGitState.mockImplementation(async () => {
        if (dirty) throw new Error('Local Git changed during recovery.');
        return {};
      });
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          posted = true;
          throw new Error('Remote result lost after GitHub accepted the POST.');
        }
        if (url.includes('/pulls?') && posted) return json([receipt]);
        if (url.endsWith('/pulls/123') && mutateOnDetail) {
          dirty = true;
          mutateOnDetail = false;
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      dirty = false;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      attestLocalReviewedGitState.mockImplementation(async () => ({}));
      t.close();
    }
  });

  it('blocks POST when the live operator grant is revoked at the final adapter gate', async () => {
    const t = setup();
    try {
      const original = t.context();
      const result = await createSessionBoundGitHubDraft({
        ...original,
        write: {
          ...original.write,
          authorizeBeforePost: () => {
            t.sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', false);
          },
        },
      });
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('blocks POST when the final journal readiness check fails closed', async () => {
    const t = setup();
    const originalAssert = DeliveryGitTransferJournal.prototype.assertReadyForDraft;
    let checks = 0;
    const readiness = vi
      .spyOn(DeliveryGitTransferJournal.prototype, 'assertReadyForDraft')
      .mockImplementation(function (this: DeliveryGitTransferJournal, identity) {
        if (++checks === 4) throw new Error('Journal readiness unavailable.');
        return originalAssert.call(this, identity);
      });
    try {
      const result = await createSessionBoundGitHubDraft(t.context());
      expect(checks).toBe(4);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      readiness.mockRestore();
      t.close();
    }
  });

  it('rejects asynchronous final authorization without sending a POST', async () => {
    const t = setup();
    try {
      const original = t.context();
      const result = await createSessionBoundGitHubDraft({
        ...original,
        write: {
          ...original.write,
          authorizeBeforePost: (() => Promise.resolve()) as unknown as () => void,
        },
      });
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('blocks POST when the trusted reviewed head changes during final GitHub ref GET', async () => {
    const t = setup();
    try {
      const original = t.context();
      const fetcher = t.fetcher.getMockImplementation()!;
      let current = original.workspace;
      let baseReads = 0;
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/git/ref/heads/main') && ++baseReads === 2) {
          current = { ...current, headSha: '3'.repeat(40) };
        }
        return fetcher(url, init);
      });
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshWorkspace: async () => current,
      });
      expect(baseReads).toBe(2);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(approvalConsumedAt(t.db, original.approvalId)).toBe(10_000);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('blocks POST when the trusted worktree identity changes during final GitHub ref GET', async () => {
    const t = setup();
    try {
      const original = t.context();
      const fetcher = t.fetcher.getMockImplementation()!;
      let current = original.workspace;
      let baseReads = 0;
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/git/ref/heads/main') && ++baseReads === 2) {
          current = {
            ...current,
            worktree: { ...current.worktree, gitDir: current.worktree.gitDir + '-swapped' },
          };
        }
        return fetcher(url, init);
      });
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshWorkspace: async () => current,
      });
      expect(baseReads).toBe(2);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('preserves one-use approval when registry refresh fails after inventory', async () => {
    const t = setup();
    try {
      const original = t.context();
      let refreshes = 0;
      await expect(
        createSessionBoundGitHubDraft({
          ...original,
          refreshWorkspace: async () => {
            if (++refreshes === 2) throw new Error('Trusted registry unavailable');
            return original.workspace;
          },
        }),
      ).rejects.toThrow('Trusted registry unavailable');
      expect(refreshes).toBe(2);
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      expect((await createSessionBoundGitHubDraft(original)).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('keeps reservation uncertain if the final registry refresh fails after reservation', async () => {
    const t = setup();
    try {
      const original = t.context();
      let refreshes = 0;
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshWorkspace: async () => {
          if (++refreshes === 4) throw new Error('Trusted registry unavailable');
          return original.workspace;
        },
      });
      expect(refreshes).toBe(4);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(approvalConsumedAt(t.db, original.approvalId)).toBe(10_000);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('keeps a completed POST uncertain when registry changes during independent PR detail GET', async () => {
    const t = setup();
    try {
      const original = t.context();
      const fetcher = t.fetcher.getMockImplementation()!;
      let current = original.workspace;
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/pulls/123')) {
          current = { ...current, baseSha: '4'.repeat(40) };
        }
        return fetcher(url, init);
      });
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshWorkspace: async () => current,
      });
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      expect(t.fetcher.mock.calls.some((call) => call[0].endsWith('/pulls/123'))).toBe(true);
    } finally {
      t.close();
    }
  });

  it('does not confirm ambiguous POST when registry changes during reconciliation detail GET', async () => {
    const t = setup();
    try {
      const original = t.context();
      const fetcher = t.fetcher.getMockImplementation()!;
      let current = original.workspace;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('Lost GitHub response');
        return fetcher(url, init);
      });
      expect(
        (
          await createSessionBoundGitHubDraft({
            ...original,
            refreshWorkspace: async () => current,
          })
        ).status,
      ).toBe('uncertain');
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) return json([receipt]);
        if (url.endsWith('/pulls/123')) {
          current = {
            ...current,
            repository: { ...current.repository, gitDir: current.repository.gitDir + '-changed' },
          };
        }
        return fetcher(url, init);
      });
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshWorkspace: async () => current,
      });
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('times out a hung POST, preserves uncertain state and never blindly retries', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) =>
        init.method === 'POST' ? new Promise<Response>(() => undefined) : original(url, init),
      );
      const context = {
        ...t.context(),
        write: { ...t.context().write, timeoutMs: 100 },
      };
      expect((await createSessionBoundGitHubDraft(context)).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect((await createSessionBoundGitHubDraft(context)).status).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('reconciles an ambiguous POST from a second SQLite connection and an independent process', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('Simulated lost GitHub response');
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const restoredSessions = new DeliverySessions(reopened, () => 10_000);
        expect(new DeliveryJournal(reopened).get('workspace-1')?.state).toBe('uncertain');
        const independent = spawnSync(
          process.execPath,
          [
            '-e',
            "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); try {const row=db.prepare('SELECT state FROM delivery_journal WHERE workspace_id=?').get('workspace-1'); process.stdout.write(String(row?.state ?? 'missing'));} finally {db.close();}",
            t.dbPath,
          ],
          { encoding: 'utf8', timeout: 5000 },
        );
        expect(independent.status).toBe(0);
        expect(independent.stdout).toBe('uncertain');
        t.fetcher.mockImplementation(async (url, init) => {
          if (url.includes('/pulls?')) return json([receipt]);
          return original(url, init);
        });
        const result = await createSessionBoundGitHubDraft({
          ...t.context(),
          sessions: restoredSessions,
        });
        expect(result.status).toBe('published');
        expect(new DeliveryJournal(reopened).get('workspace-1')?.pullRequestUrl).toBe(
          receipt.html_url,
        );
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });

  it('recovers a reservation from a killed publisher without issuing a second POST', async () => {
    const t = setup();
    try {
      // Persist the approval consumption and journal reservation together,
      // as the real approved executor does before attempting a remote POST.
      const killed = interruptReservationTransaction(
        t.dbPath,
        t.context().approvalId,
        publicationKey(plan),
        true,
      );
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get('workspace-1')?.state).toBe('reserved');
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBe(10_000);
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('Recovered operation must not write.');
        if (url.includes('/pulls?')) return json([receipt]);
        return original(url, init);
      });
      const restoredDb = new DatabaseSync(t.dbPath);
      try {
        const result = await createSessionBoundGitHubDraft({
          ...t.context(),
          sessions: new DeliverySessions(restoredDb, () => 10_000),
        });
        expect(result.status).toBe('published');
        expect(new DeliveryJournal(restoredDb).get('workspace-1')?.pullRequestUrl).toBe(
          receipt.html_url,
        );
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      } finally {
        restoredDb.close();
      }
    } finally {
      t.close();
    }
  });

  it('rolls back approval consumption and reservation when killed before COMMIT', async () => {
    const t = setup();
    try {
      const killed = interruptReservationTransaction(
        t.dbPath,
        t.context().approvalId,
        publicationKey(plan),
        false,
      );
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBeNull();
      const result = await createSessionBoundGitHubDraft(t.context());
      expect(result.status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('does not POST after a committed reservation if remote inventory finds no PR', async () => {
    const t = setup();
    try {
      const killed = interruptReservationTransaction(
        t.dbPath,
        t.context().approvalId,
        publicationKey(plan),
        true,
      );
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get('workspace-1')?.state).toBe('reserved');
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('treats invalid post-write PR detail as uncertain, not published', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) =>
        url.endsWith('/pulls/123')
          ? json({ ...receipt, base: { ...receipt.base, sha: '4'.repeat(40) } })
          : original(url, init),
      );
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });
});
