import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';

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
const binding = {
  workspaceId: 'workspace-backup',
  operator: { operatorId: 'operator-1', sessionId: 'session-1' },
  plan,
  commits: {
    operationKey: publicationKey(plan),
    headCommitSha: headSha,
    baseCommitSha: baseSha,
  },
};
const identity = {
  workspaceId: binding.workspaceId,
  operationKey: binding.commits.operationKey,
  destination: plan.destination,
  branch: plan.branch,
  headSha,
  baseSha,
};

describe('delivery SQLite WAL backup and offline restore safety', () => {
  it('restores consumed approval, uncertain PR and confirmed transfers from WAL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-delivery-backup-'));
    const livePath = join(directory, 'live.sqlite');
    const snapshotPath = join(directory, 'snapshot.sqlite');
    const live = new DatabaseSync(livePath);
    try {
      expect(live.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode).toBe('wal');
      const publications = new DeliveryJournal(live);
      const transfers = new DeliveryGitTransferJournal(live);
      const approvals = new DeliveryPublicationApprovalLedger(live, () => 10_000);
      const approvalId = approvals.issue(binding);
      transfers.begin('commit', identity);
      transfers.confirmVerified('commit', identity, headSha);
      transfers.begin('push', identity);
      transfers.confirmVerified('push', identity, headSha);
      publications.reserve(identity.workspaceId, identity.operationKey);
      approvals.consume(approvalId, binding);
      publications.markUncertain(identity.workspaceId, identity.operationKey);

      // SQLite's online backup includes committed WAL data even if the source
      // connection remains open. A raw copy of the .sqlite file would not.
      await backup(live, snapshotPath);
      const restored = new DatabaseSync(snapshotPath);
      try {
        const restoredPublications = new DeliveryJournal(restored);
        const restoredTransfers = new DeliveryGitTransferJournal(restored);
        const restoredApprovals = new DeliveryPublicationApprovalLedger(restored, () => 10_000);
        expect(restored.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(restoredPublications.get(identity.workspaceId)).toMatchObject({
          operationKey: identity.operationKey,
          state: 'uncertain',
          pullRequestUrl: null,
        });
        expect(restoredTransfers.get(identity.workspaceId, 'commit')).toMatchObject({
          state: 'confirmed',
          receiptSha: headSha,
        });
        expect(restoredTransfers.get(identity.workspaceId, 'push')).toMatchObject({
          state: 'confirmed',
          receiptSha: headSha,
        });
        expect(() => restoredApprovals.assertPending(approvalId, binding)).toThrow(
          'missing, expired or no longer valid',
        );
        expect(() =>
          restoredPublications.reserve(identity.workspaceId, identity.operationKey),
        ).toThrow('already exists');
        expect(() =>
          restored.exec(
            "UPDATE delivery_journal SET state='reserved' WHERE workspace_id='workspace-backup'",
          ),
        ).toThrow('advance monotonically');
        expect(() =>
          restored.exec("DELETE FROM delivery_git_transfers WHERE workspace_id='workspace-backup'"),
        ).toThrow('cannot be deleted');
        expect(restoredPublications.listUnresolved()).toHaveLength(1);
      } finally {
        restored.close();
      }
    } finally {
      live.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves SQL replay guards across WAL backup and independent restored connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-delivery-replay-restore-'));
    const source = new DatabaseSync(join(directory, 'live.sqlite'));
    const snapshotPath = join(directory, 'snapshot.sqlite');
    try {
      source.exec('PRAGMA journal_mode=WAL');
      const publications = new DeliveryJournal(source);
      const transfers = new DeliveryGitTransferJournal(source);
      transfers.begin('commit', identity);
      transfers.confirmVerified('commit', identity, headSha);
      transfers.begin('push', identity);
      transfers.confirmVerified('push', identity, headSha);
      publications.reserve(identity.workspaceId, identity.operationKey);
      publications.markUncertain(identity.workspaceId, identity.operationKey);
      await backup(source, snapshotPath);

      // Both connections reopen the restored file independently. In SQLite,
      // INSERT OR REPLACE can silently erase a row if only DELETE triggers
      // protect it and recursive_triggers is disabled (the default).
      const first = new DatabaseSync(snapshotPath);
      const second = new DatabaseSync(snapshotPath);
      try {
        const restoredPublications = new DeliveryJournal(first);
        const restoredTransfers = new DeliveryGitTransferJournal(second);
        const replacePublication = first.prepare(
          "INSERT OR REPLACE INTO delivery_journal (workspace_id, operation_key, state, pull_request_url) VALUES (?, ?, 'reserved', NULL)",
        );
        expect(() => replacePublication.run(identity.workspaceId, identity.operationKey)).toThrow(
          'already exists',
        );

        const replacePush = second.prepare(
          "INSERT OR REPLACE INTO delivery_git_transfers (workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha) VALUES (?, 'push', ?, ?, ?, ?, ?, 'intent', NULL)",
        );
        expect(() =>
          replacePush.run(
            identity.workspaceId,
            identity.operationKey,
            identity.destination,
            identity.branch,
            identity.headSha,
            identity.baseSha,
          ),
        ).toThrow('already exists');

        const deletePublication = () =>
          first.exec("DELETE FROM delivery_journal WHERE workspace_id='workspace-backup'");
        const deleteTransfers = () =>
          second.exec("DELETE FROM delivery_git_transfers WHERE workspace_id='workspace-backup'");
        expect(deletePublication).toThrow('cannot be deleted');
        expect(deleteTransfers).toThrow('cannot be deleted');

        const secondPublicationJournal = new DeliveryJournal(second);
        expect(() =>
          secondPublicationJournal.reserve('workspace-foreign', identity.operationKey),
        ).toThrow('belongs to another workspace');

        expect(restoredPublications.get(identity.workspaceId)).toMatchObject({
          operationKey: identity.operationKey,
          state: 'uncertain',
          pullRequestUrl: null,
        });
        expect(() => restoredTransfers.assertReadyForDraft(identity)).not.toThrow();
        expect(restoredTransfers.get(identity.workspaceId, 'push')).toMatchObject({
          state: 'confirmed',
          receiptSha: headSha,
        });
      } finally {
        second.close();
        first.close();
      }
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a stale restored publication uncertain after a newer live receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-delivery-stale-backup-'));
    const source = new DatabaseSync(join(directory, 'live.sqlite'));
    const snapshotPath = join(directory, 'snapshot.sqlite');
    const pullRequestUrl = 'https://github.com/vlovers/ai-office/pull/123';
    try {
      source.exec('PRAGMA journal_mode=WAL');
      const liveJournal = new DeliveryJournal(source);
      liveJournal.reserve(identity.workspaceId, identity.operationKey);
      liveJournal.markUncertain(identity.workspaceId, identity.operationKey);
      await backup(source, snapshotPath);

      liveJournal.confirmUncertain(identity.workspaceId, identity.operationKey, pullRequestUrl);
      expect(liveJournal.get(identity.workspaceId)?.state).toBe('published');

      const restored = new DatabaseSync(snapshotPath);
      try {
        const journal = new DeliveryJournal(restored);
        expect(restored.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(journal.get(identity.workspaceId)).toMatchObject({
          operationKey: identity.operationKey,
          state: 'uncertain',
          pullRequestUrl: null,
        });
        expect(() => journal.reserve(identity.workspaceId, identity.operationKey)).toThrow(
          'already exists',
        );
        expect(() =>
          journal.publish(identity.workspaceId, identity.operationKey, pullRequestUrl),
        ).toThrow('requires manual recovery');
        expect(journal.listUnresolved()).toHaveLength(1);
        expect(journal.get(identity.workspaceId)?.state).toBe('uncertain');
      } finally {
        restored.close();
      }
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on legacy duplicate owners after backup and restore', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-delivery-legacy-backup-'));
    const live = new DatabaseSync(join(directory, 'live.sqlite'));
    const snapshotPath = join(directory, 'snapshot.sqlite');
    try {
      live.exec(`CREATE TABLE delivery_journal (
        workspace_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        pull_request_url TEXT
      )`);
      live
        .prepare("INSERT INTO delivery_journal VALUES (?, ?, 'reserved', NULL)")
        .run('workspace-a', 'shared-legacy-operation');
      live
        .prepare("INSERT INTO delivery_journal VALUES (?, ?, 'uncertain', NULL)")
        .run('workspace-b', 'shared-legacy-operation');
      await backup(live, snapshotPath);
      const restored = new DatabaseSync(snapshotPath);
      try {
        const journal = new DeliveryJournal(restored);
        expect(() => journal.get('workspace-a')).toThrow('belongs to another workspace');
        expect(() => journal.get('workspace-b')).toThrow('belongs to another workspace');
        expect(() => journal.listUnresolved()).toThrow('belongs to another workspace');
        expect(() => journal.reserve('workspace-c', 'shared-legacy-operation')).toThrow(
          'belongs to another workspace',
        );
        const restoredRows = restored
          .prepare('SELECT COUNT(*) AS total FROM delivery_journal')
          .get();
        expect(restoredRows?.total).toBe(2);
      } finally {
        restored.close();
      }
    } finally {
      live.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
