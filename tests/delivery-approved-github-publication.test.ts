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
  let posted = false;
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'POST') {
      posted = true;
      return json(receipt, 201);
    }
    if (url.includes('/git/ref/heads/')) {
      const branch = url.endsWith('/main') ? 'main' : plan.branch;
      return json({
        ref: 'refs/heads/' + branch,
        object: { type: 'commit', sha: branch === 'main' ? baseSha : headSha },
      });
    }
    if (url.includes('/pulls?')) return json(posted ? [receipt] : []);
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
  it('rejects invalid GitHub write deadlines before consuming the one-use approval', async () => {
    const t = setup();
    try {
      for (const timeoutMs of [0, 99, 60_001, -1, 1.5, Number.NaN, Infinity]) {
        const original = t.context();
        await expect(
          createSessionBoundGitHubDraft({
            ...original,
            write: { ...original.write, timeoutMs },
          }),
        ).rejects.toThrow('Invalid GitHub draft write deadline');
      }
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('rejects malformed cancellation and authorization configuration before any durable intent', async () => {
    const t = setup();
    try {
      const original = t.context();
      const invalidOptions = [
        { signal: { aborted: false } },
        {
          signal: {
            aborted: false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
        },
        { authorizeBeforePost: 'approved' },
        { authorizeBeforePost: null },
      ];
      for (const invalid of invalidOptions) {
        await expect(
          createSessionBoundGitHubDraft({
            ...original,
            write: {
              ...original.write,
              ...invalid,
            } as unknown as Parameters<typeof createSessionBoundGitHubDraft>[0]['write'],
          }),
        ).rejects.toThrow(/Invalid GitHub draft write (abort signal|authorization hook)/);
        expect(t.journal.get('workspace-1')).toBeNull();
        expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
        expect(t.fetcher).not.toHaveBeenCalled();
      }
      // A bad server-side adapter configuration must not burn the operator's
      // approval or prevent a later correctly configured publication.
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('preserves approval and journal when a Draft write is cancelled before reservation', async () => {
    const t = setup();
    const controller = new AbortController();
    try {
      controller.abort();
      const original = t.context();
      await expect(
        createSessionBoundGitHubDraft({
          ...original,
          write: { ...original.write, signal: controller.signal },
        }),
      ).rejects.toThrow('GitHub draft write aborted before reservation');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it.each([422, 429, 503])(
    'keeps a GitHub Draft POST HTTP %i uncertain and refuses a second POST',
    async (status) => {
      const t = setup();
      try {
        const original = t.context();
        let postCount = 0;
        const fetcher = vi.fn(async (url: string, init: RequestInit) => {
          if (init.method === 'POST') {
            postCount++;
            return json({ message: 'untrusted GitHub error' }, status);
          }
          return t.fetcher(url, init);
        });
        const context = { ...original, write: { ...original.write, fetcher } };
        expect((await createSessionBoundGitHubDraft(context)).status).toBe('uncertain');
        expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
        // A complete negative GET inventory after the failed POST is not
        // permission to consume another approval or attempt a second write.
        expect((await createSessionBoundGitHubDraft(context)).status).toBe('uncertain');
        expect(postCount).toBe(1);
        expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      } finally {
        t.close();
      }
    },
  );

  it.each(['redirected', 'foreign-response-url'])(
    'keeps a %s GitHub Draft POST uncertain without replay',
    async (mode) => {
      const t = setup();
      try {
        const original = t.context();
        let postCount = 0;
        const fetcher = vi.fn(async (url: string, init: RequestInit) => {
          if (init.method === 'POST') {
            postCount++;
            expect(init.redirect).toBe('error');
            const response = json(receipt, 201);
            if (mode === 'redirected') {
              Object.defineProperty(response, 'redirected', { value: true });
            } else {
              Object.defineProperty(response, 'url', {
                value: 'https://untrusted.example.invalid/pulls',
              });
            }
            return response;
          }
          return t.fetcher(url, init);
        });
        const context = { ...original, write: { ...original.write, fetcher } };
        expect((await createSessionBoundGitHubDraft(context)).status).toBe('uncertain');
        expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
        expect((await createSessionBoundGitHubDraft(context)).status).toBe('uncertain');
        expect(postCount).toBe(1);
      } finally {
        t.close();
      }
    },
  );

  it('blocks a drifting preflight inventory before consuming approval or issuing POST', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    const unrelated = {
      ...receipt,
      number: 901,
      html_url: 'https://github.com/vlovers/ai-office/pull/901',
      head: { ...receipt.head, ref: 'other-branch' },
    };
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) {
          if (url.includes('page=2')) return json([unrelated]);
          const next = url.replace('page=1', 'page=2');
          return new Response(JSON.stringify([unrelated]), {
            status: 200,
            headers: { Link: `<${next}>; rel="next"` },
          });
        }
        return original(url, init);
      });
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow(
        'Remote PR inventory failed',
      );
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);

      t.fetcher.mockImplementation(original);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('preserves the one-use approval when a full paginated inventory changes between passes', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      ...receipt,
      number: 1000 + index,
      html_url: `https://github.com/vlovers/ai-office/pull/${1000 + index}`,
      head: { ...receipt.head, ref: `unrelated-${index}` },
    }));
    let firstPageReads = 0;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) {
          const page = Number(new URL(url).searchParams.get('page'));
          if (page !== 1) return json([]);
          firstPageReads += 1;
          return json(
            firstPageReads === 1
              ? unrelated
              : unrelated.map((candidate, index) =>
                  index === 0
                    ? {
                        ...candidate,
                        number: 2000,
                        html_url: 'https://github.com/vlovers/ai-office/pull/2000',
                      }
                    : candidate,
                ),
          );
        }
        return original(url, init);
      });
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow(
        'Remote PR inventory failed',
      );
      expect(firstPageReads).toBe(2);
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);

      t.fetcher.mockImplementation(original);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('keeps a completed POST uncertain when the receipt inventory shifts across pages', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    let posted = false;
    let drifting = true;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          posted = true;
          return original(url, init);
        }
        if (posted && drifting && url.includes('/pulls?')) {
          if (url.includes('page=2')) return json([receipt]);
          const next = url.replace('page=1', 'page=2');
          return new Response(JSON.stringify([receipt]), {
            status: 200,
            headers: { Link: `<${next}>; rel="next"` },
          });
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')).toMatchObject({
        state: 'uncertain',
        pullRequestUrl: null,
      });
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBe(10_000);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);

      drifting = false;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('keeps an accepted POST uncertain on second-pass PR inventory drift and recovers by GET', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    const unrelated = Array.from({ length: 99 }, (_, index) => ({
      ...receipt,
      number: 1000 + index,
      html_url: `https://github.com/vlovers/ai-office/pull/${1000 + index}`,
      head: { ...receipt.head, ref: `unrelated-${index}` },
    }));
    let posted = false;
    let drifting = true;
    let postInventoryPasses = 0;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          posted = true;
          return original(url, init);
        }
        if (posted && drifting && url.includes('/pulls?')) {
          const page = Number(new URL(url).searchParams.get('page'));
          if (page !== 1) return json([]);
          postInventoryPasses += 1;
          return json([
            receipt,
            ...unrelated.map((candidate, index) =>
              postInventoryPasses === 2 && index === 0
                ? {
                    ...candidate,
                    number: 2000,
                    html_url: 'https://github.com/vlovers/ai-office/pull/2000',
                  }
                : candidate,
            ),
          ]);
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(postInventoryPasses).toBe(2);
      expect(t.journal.get('workspace-1')).toMatchObject({
        state: 'uncertain',
        pullRequestUrl: null,
      });
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBe(10_000);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);

      drifting = false;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('preserves approval when the managed head moves between the first and final ref GET', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    let headReads = 0;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'GET' && url.includes('/git/ref/heads/') && !url.endsWith('/main')) {
          headReads++;
          return json({
            ref: 'refs/heads/' + plan.branch,
            object: { type: 'commit', sha: headReads === 1 ? headSha : 'f'.repeat(40) },
          });
        }
        return original(url, init);
      });
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow(
        'head branch moved during remote attestation',
      );
      expect(headReads).toBe(2);
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);

      t.fetcher.mockImplementation(original);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('retains an uncertain reservation if the head moves during final pre-POST attestation', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    let headReads = 0;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'GET' && url.includes('/git/ref/heads/') && !url.endsWith('/main')) {
          headReads++;
          return json({
            ref: 'refs/heads/' + plan.branch,
            object: { type: 'commit', sha: headReads === 5 ? 'f'.repeat(40) : headSha },
          });
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(headReads).toBe(5);
      expect(t.journal.get('workspace-1')).toMatchObject({
        state: 'uncertain',
        pullRequestUrl: null,
      });
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBe(10_000);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);

      t.fetcher.mockImplementation(original);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

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

  it('does not consume approval or reserve a journal row after cumulative preflight timeout', async () => {
    const t = setup();
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const original = t.fetcher.getMockImplementation()!;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (url.includes('/pulls?')) elapsed = 150;
        return response;
      });
      await expect(
        createSessionBoundGitHubDraft({ ...t.context(), inventoryDeadlineMs: 200 }),
      ).rejects.toThrow('Remote PR inventory failed');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);

      elapsed = 0;
      t.fetcher.mockImplementation(original);
      expect(
        (await createSessionBoundGitHubDraft({ ...t.context(), inventoryDeadlineMs: 200 })).status,
      ).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      clock.mockRestore();
      t.close();
    }
  });

  it('keeps a completed POST uncertain on cumulative receipt-inventory timeout and recovers GET-only', async () => {
    const t = setup();
    let elapsed = 0;
    let posted = false;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const original = t.fetcher.getMockImplementation()!;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        if (init.method === 'POST') posted = true;
        if (url.includes('/pulls?') && posted) elapsed = 150;
        return response;
      });
      expect(
        (await createSessionBoundGitHubDraft({ ...t.context(), inventoryDeadlineMs: 200 })).status,
      ).toBe('uncertain');
      expect(t.journal.get('workspace-1')).toMatchObject({
        state: 'uncertain',
        pullRequestUrl: null,
      });
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);

      elapsed = 0;
      t.fetcher.mockImplementation(original);
      expect(
        (await createSessionBoundGitHubDraft({ ...t.context(), inventoryDeadlineMs: 200 })).status,
      ).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      clock.mockRestore();
      t.close();
    }
  });

  it.each([1, 2] as const)(
    'releases the Git lease on a hung trusted registry refresh #%i before approval consumption',
    async (hangAt) => {
      const t = setup();
      const original = t.context();
      let refreshes = 0;
      try {
        await expect(
          createSessionBoundGitHubDraft({
            ...original,
            refreshDeadlineMs: 100,
            refreshWorkspace: async () => {
              if (++refreshes === hangAt) {
                return new Promise<typeof original.workspace>(() => undefined);
              }
              return original.workspace;
            },
          }),
        ).rejects.toThrow('registry refresh timed out');
        expect(refreshes).toBe(hangAt);
        expect(t.journal.get('workspace-1')).toBeNull();
        expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
        expect((await createSessionBoundGitHubDraft(original)).status).toBe('published');
      } finally {
        t.close();
      }
    },
  );

  it('preserves a durable uncertain reservation if the final registry refresh hangs', async () => {
    const t = setup();
    const original = t.context();
    let refreshes = 0;
    try {
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshDeadlineMs: 100,
        refreshWorkspace: async () => {
          if (++refreshes === 4) return new Promise<typeof original.workspace>(() => undefined);
          return original.workspace;
        },
      });
      expect(refreshes).toBe(4);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')).toMatchObject({
        state: 'uncertain',
        pullRequestUrl: null,
      });
      expect(approvalConsumedAt(t.db, original.approvalId)).toBe(10_000);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      expect((await createSessionBoundGitHubDraft(original)).status).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('recovers a successful POST after post-write registry timeout without another POST', async () => {
    const t = setup();
    const original = t.context();
    const transport = t.fetcher.getMockImplementation()!;
    let posted = false;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') posted = true;
        return transport(url, init);
      });
      const result = await createSessionBoundGitHubDraft({
        ...original,
        refreshDeadlineMs: 100,
        refreshWorkspace: async () =>
          posted ? new Promise<typeof original.workspace>(() => undefined) : original.workspace,
      });
      expect(posted).toBe(true);
      expect(result.status).toBe('uncertain');
      expect(t.journal.get('workspace-1')).toMatchObject({
        state: 'uncertain',
        pullRequestUrl: null,
      });
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      expect((await createSessionBoundGitHubDraft(original)).status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('exhausts a cumulative registry budget without consuming one-use approval', async () => {
    const t = setup();
    const original = t.context();
    const transport = t.fetcher.getMockImplementation()!;
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        const response = await transport(url, init);
        if (url.includes('/pulls?')) elapsed = 150;
        return response;
      });
      await expect(
        createSessionBoundGitHubDraft({
          ...original,
          refreshBudgetMs: 200,
        }),
      ).rejects.toThrow('registry refresh budget exhausted');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      clock.mockRestore();
      t.fetcher.mockImplementation(transport);
      expect((await createSessionBoundGitHubDraft(original)).status).toBe('published');
    } finally {
      clock.mockRestore();
      t.close();
    }
  });

  it('rejects invalid registry deadlines before GitHub traffic or approval consumption', async () => {
    const t = setup();
    const original = t.context();
    try {
      for (const invalid of [0, 99, -1, 60_001, 1.5, Number.NaN, Infinity]) {
        await expect(
          createSessionBoundGitHubDraft({ ...original, refreshDeadlineMs: invalid }),
        ).rejects.toThrow('Invalid trusted delivery registry refresh deadline');
        await expect(
          createSessionBoundGitHubDraft({ ...original, refreshBudgetMs: invalid }),
        ).rejects.toThrow('Invalid trusted delivery registry refresh budget');
      }
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('ignores a late trusted registry success after cancellation', async () => {
    const t = setup();
    const original = t.context();
    const controller = new AbortController();
    let refreshes = 0;
    let finish!: (workspace: typeof original.workspace) => void;
    const pending = new Promise<typeof original.workspace>((resolve) => {
      finish = resolve;
    });
    try {
      const attempt = createSessionBoundGitHubDraft({
        ...original,
        refreshDeadlineMs: 1000,
        refreshWorkspace: async () => {
          refreshes++;
          return pending;
        },
        write: { ...original.write, signal: controller.signal },
      });
      await vi.waitFor(() => expect(refreshes).toBe(1));
      controller.abort();
      await expect(attempt).rejects.toThrow('registry refresh aborted');
      finish(original.workspace);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('keeps a completed POST uncertain when page two contains a competing managed head', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    let posted = false;
    let conflicting = true;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          posted = true;
          return original(url, init);
        }
        if (url.includes('/pulls?') && posted && conflicting) {
          if (url.includes('page=2')) {
            return json([
              {
                ...receipt,
                number: 456,
                html_url: 'https://github.com/vlovers/ai-office/pull/456',
                base: { ...receipt.base, ref: 'develop' },
              },
            ]);
          }
          const nextPage = url.replace('page=1', 'page=2');
          return new Response(JSON.stringify([receipt]), {
            status: 200,
            headers: { Link: `<${nextPage}>; rel="next"` },
          });
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      conflicting = false;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it.each(['rate-limit', 'not-yet-visible'] as const)(
    'does not retry a completed POST when post-write inventory is %s',
    async (failure) => {
      const t = setup();
      const original = t.fetcher.getMockImplementation()!;
      let posted = false;
      let failOnce = true;
      try {
        t.fetcher.mockImplementation(async (url, init) => {
          if (init.method === 'POST') {
            posted = true;
            return original(url, init);
          }
          if (url.includes('/pulls?') && posted && failOnce) {
            failOnce = false;
            return failure === 'rate-limit' ? json({ message: 'rate limited' }, 429) : json([]);
          }
          return original(url, init);
        });
        expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
        expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
        expect(t.journal.get('workspace-1')?.pullRequestUrl).toBeNull();
        expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
        expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      } finally {
        t.close();
      }
    },
  );

  it('refuses to confirm a POST after grant revocation during the post-write inventory', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    let posted = false;
    let revoked = false;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          posted = true;
          return original(url, init);
        }
        if (url.includes('/pulls?') && posted && !revoked) {
          revoked = true;
          t.sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', false);
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(revoked).toBe(true);
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      t.sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', true);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
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

  it('does not adopt a PR with conflicting managed-head ownership after restart', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      const conflicting = {
        ...receipt,
        number: 124,
        html_url: 'https://github.com/vlovers/ai-office/pull/124',
        state: 'closed',
        base: { ...receipt.base, ref: 'release' },
      };
      let postAttempted = false;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          postAttempted = true;
          throw new Error('GitHub accepted POST but reply was lost');
        }
        if (url.includes('/pulls?') && postAttempted) {
          if (url.includes('page=2')) return json([conflicting]);
          const nextPage = url.replace('page=1', 'page=2');
          return new Response(JSON.stringify([receipt]), {
            status: 200,
            headers: { Link: `<${nextPage}>; rel="next"` },
          });
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(approvalConsumedAt(t.db, t.context().approvalId)).toBe(10_000);
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const recoveredContext = {
          ...t.context(),
          sessions: new DeliverySessions(reopened, () => 10_000),
        };
        const blocked = await createSessionBoundGitHubDraft(recoveredContext);
        expect(blocked.status).toBe('uncertain');
        expect(new DeliveryJournal(reopened).get('workspace-1')?.pullRequestUrl).toBeNull();
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
        // An independently complete inventory without the conflicting head
        // can confirm the original attempt. Recovery still performs GET only.
        t.fetcher.mockImplementation(async (url, init) => {
          if (init.method === 'POST') throw new Error('Recovery must never POST');
          if (url.includes('/pulls?')) return json([receipt]);
          return original(url, init);
        });
        expect((await createSessionBoundGitHubDraft(recoveredContext)).status).toBe('published');
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

  it('re-attests local Git immediately before the single POST', async () => {
    const t = setup();
    try {
      const before = attestLocalReviewedGitState.mock.calls.length;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      // The eighth attestation runs after the PR detail GET, immediately
      // before the durable published receipt is committed.
      expect(attestLocalReviewedGitState.mock.calls.length - before).toBe(8);
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
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
      expect(baseReads).toBe(2);
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      dirty = false;
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
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
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
      expect(checks).toBe(4);
      expect(t.journal.get('workspace-1')).toBeNull();
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
      await expect(
        createSessionBoundGitHubDraft({
          ...original,
          refreshWorkspace: async () => current,
        }),
      ).rejects.toThrow();
      expect(baseReads).toBe(2);
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(approvalConsumedAt(t.db, original.approvalId)).toBeNull();
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
      await expect(
        createSessionBoundGitHubDraft({
          ...original,
          refreshWorkspace: async () => current,
        }),
      ).rejects.toThrow();
      expect(baseReads).toBe(2);
      expect(t.journal.get('workspace-1')).toBeNull();
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

  it.each(['post', 'detail', 'inventory'] as const)(
    'recovers a conflicting %s PR identity without replaying the Draft POST',
    async (failure) => {
      const t = setup();
      const original = t.fetcher.getMockImplementation()!;
      let posted = false;
      let corrupt = true;
      try {
        t.fetcher.mockImplementation(async (url, init) => {
          if (init.method === 'POST') {
            posted = true;
            const response = await original(url, init);
            return corrupt && failure === 'post'
              ? json({ ...receipt, number: 124 }, 201)
              : response;
          }
          if (corrupt && failure === 'detail' && url.endsWith('/pulls/123')) {
            return json({
              ...receipt,
              html_url: 'https://github.com/vlovers/ai-office/pull/124',
            });
          }
          if (corrupt && failure === 'inventory' && posted && url.includes('/pulls?')) {
            return json([{ ...receipt, number: 124 }]);
          }
          return original(url, init);
        });
        expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
        expect(t.journal.get('workspace-1')).toMatchObject({
          state: 'uncertain',
          pullRequestUrl: null,
        });
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);

        corrupt = false;
        expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
        expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      } finally {
        t.close();
      }
    },
  );

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
