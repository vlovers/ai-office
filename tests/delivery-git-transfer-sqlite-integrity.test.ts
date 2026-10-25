import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferIdentity,
} from '../src/server/delivery-git-transfer-journal.js';

const identity: DeliveryGitTransferIdentity = {
  workspaceId: 'reviewed-workspace',
  operationKey: 'reviewed-operation',
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-sqlite-integrity-'));
  const path = join(root, 'delivery.sqlite');
  const db = new DatabaseSync(path);
  const journal = new DeliveryGitTransferJournal(db);
  return {
    db,
    path,
    journal,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function insertDirect(db: DatabaseSync, state: string, receipt: string | null) {
  return db
    .prepare(
      `INSERT INTO delivery_git_transfers
       (workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha)
       VALUES (?, 'commit', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identity.workspaceId,
      identity.operationKey,
      identity.destination,
      identity.branch,
      identity.headSha,
      identity.baseSha,
      state,
      receipt,
    );
}

describe('durable Git transfer SQLite integrity boundaries', () => {
  it('rejects a direct confirmed insert without a reserved intent', () => {
    const t = setup();
    try {
      expect(() => insertDirect(t.db, 'confirmed', identity.headSha)).toThrow('receipt-free intent');
      expect(t.journal.get(identity.workspaceId, 'commit')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('rejects an inserted uncertain state and a receipt on an intent', () => {
    const t = setup();
    try {
      expect(() => insertDirect(t.db, 'uncertain', null)).toThrow('receipt-free intent');
      expect(() => insertDirect(t.db, 'intent', identity.headSha)).toThrow('receipt-free intent');
      expect(t.journal.get(identity.workspaceId, 'commit')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('allows the intended intent to uncertain to confirmed lifecycle', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      expect(t.journal.recoverWorkspace('commit', identity).state).toBe('uncertain');
      expect(t.journal.confirmVerified('commit', identity, identity.headSha)).toMatchObject({
        state: 'confirmed',
        receiptSha: identity.headSha,
      });
      expect(t.journal.confirmVerified('commit', identity, identity.headSha).state).toBe(
        'confirmed',
      );
      const reopened = new DatabaseSync(t.path);
      try {
        const restarted = new DeliveryGitTransferJournal(reopened);
        expect(restarted.assertConfirmed('commit', identity).receiptSha).toBe(identity.headSha);
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });

  it('prevents direct changes to the reviewed operation, destination, branch and SHAs', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      for (const [column, value] of [
        ['operation_key', 'other-operation'],
        ['destination', 'https://github.com/foreign/repository'],
        ['branch', 'ai-office/22345678-1234-1234-1234-123456789abc'],
        ['head_sha', 'f'.repeat(40)],
        ['base_sha', 'f'.repeat(40)],
      ] as const) {
        expect(() =>
          t.db
            .prepare(`UPDATE delivery_git_transfers SET ${column}=? WHERE workspace_id=?`)
            .run(value, identity.workspaceId),
        ).toThrow('immutable');
      }
      expect(t.journal.assertOwned('commit', identity).state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('prevents changing stage or workspace even without a foreign owner', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      expect(() =>
        t.db
          .prepare("UPDATE delivery_git_transfers SET stage='push' WHERE workspace_id=?")
          .run(identity.workspaceId),
      ).toThrow('immutable');
      expect(() =>
        t.db
          .prepare("UPDATE delivery_git_transfers SET workspace_id='other' WHERE workspace_id=?")
          .run(identity.workspaceId),
      ).toThrow('immutable');
      expect(t.journal.get(identity.workspaceId, 'push')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('refuses direct receipt injection or state reset on an uncertain intent', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      t.journal.markUncertain('commit', identity);
      expect(() =>
        t.db
          .prepare("UPDATE delivery_git_transfers SET state='intent' WHERE workspace_id=?")
          .run(identity.workspaceId),
      ).toThrow('monotonically');
      expect(() =>
        t.db
          .prepare('UPDATE delivery_git_transfers SET receipt_sha=? WHERE workspace_id=?')
          .run(identity.headSha, identity.workspaceId),
      ).toThrow('monotonically');
      expect(t.journal.get(identity.workspaceId, 'commit')).toMatchObject({
        state: 'uncertain',
        receiptSha: null,
      });
    } finally {
      t.close();
    }
  });

  it('rejects a forged SHA, downgrade or overwrite of a confirmed receipt', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      expect(() =>
        t.db
          .prepare("UPDATE delivery_git_transfers SET state='confirmed', receipt_sha=NULL")
          .run(),
      ).toThrow('monotonically');
      expect(() =>
        t.db
          .prepare("UPDATE delivery_git_transfers SET state='confirmed', receipt_sha=?")
          .run('f'.repeat(40)),
      ).toThrow('monotonically');
      t.journal.confirmVerified('commit', identity, identity.headSha);
      expect(() =>
        t.db
          .prepare("UPDATE delivery_git_transfers SET state='uncertain', receipt_sha=NULL")
          .run(),
      ).toThrow('monotonically');
      expect(() =>
        t.db
          .prepare('UPDATE delivery_git_transfers SET receipt_sha=?')
          .run('f'.repeat(40)),
      ).toThrow('monotonically');
      expect(t.journal.assertConfirmed('commit', identity).receiptSha).toBe(identity.headSha);
    } finally {
      t.close();
    }
  });

  it('enforces the same receipt rules in another Node process after restart', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      t.journal.confirmVerified('commit', identity, identity.headSha);
      const script = [
        "const { DatabaseSync } = require('node:sqlite');",
        'const db = new DatabaseSync(process.argv[1]);',
        "try { db.exec(\"UPDATE delivery_git_transfers SET state='intent', receipt_sha=NULL\"); process.exit(43); }",
        "catch (error) { process.exit(String(error).includes('monotonically') ? 42 : 44); }",
      ].join(' ');
      const child = spawnSync(process.execPath, ['-e', script, t.path], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(child.status).toBe(42);
      expect(t.journal.assertConfirmed('commit', identity).receiptSha).toBe(identity.headSha);
    } finally {
      t.close();
    }
  });

  it('retains pre-upgrade corrupted rows for manual investigation without rewriting them', () => {
    const t = setup();
    try {
      t.db.exec('DROP TRIGGER delivery_git_transfers_intent_only_insert');
      insertDirect(t.db, 'confirmed', 'f'.repeat(40));
      const before = t.db.prepare('SELECT * FROM delivery_git_transfers').all();
      const restarted = new DeliveryGitTransferJournal(t.db);
      expect(() => restarted.assertConfirmed('commit', identity)).toThrow('not confirmed');
      expect(t.db.prepare('SELECT * FROM delivery_git_transfers').all()).toEqual(before);
    } finally {
      t.close();
    }
  });
});
