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

const branch = 'ai-office/12345678-1234-1234-1234-123456789abc';
const anotherBranch = 'ai-office/22345678-1234-1234-1234-123456789abc';
const destination = 'https://github.com/vlovers/ai-office';

function identity(
  workspaceId = 'primary',
  overrides: Partial<DeliveryGitTransferIdentity> = {},
): DeliveryGitTransferIdentity {
  return {
    workspaceId,
    operationKey: JSON.stringify([destination, branch, 'main', 'a'.repeat(64), true]),
    destination,
    branch,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    ...overrides,
  };
}

function confirmBoth(journal: DeliveryGitTransferJournal, owner: DeliveryGitTransferIdentity) {
  journal.begin('commit', owner);
  journal.confirmVerified('commit', owner, owner.headSha);
  journal.begin('push', owner);
  journal.confirmVerified('push', owner, owner.headSha);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-transfer-ownership-'));
  const dbPath = join(root, 'delivery.sqlite');
  const db = new DatabaseSync(dbPath);
  const journal = new DeliveryGitTransferJournal(db);
  return {
    db,
    dbPath,
    journal,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Draft PR transfer ownership and replay isolation', () => {
  it('allows exact independent receipts for a single workspace', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      expect(() => t.journal.assertReadyForDraft(owner)).not.toThrow();
      expect(t.journal.get(owner.workspaceId, 'push')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });

  it('still refuses missing or uncertain receipts before ownership checks', () => {
    const t = setup();
    try {
      const owner = identity();
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('missing');
      t.journal.begin('commit', owner);
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('not confirmed');
      t.journal.confirmVerified('commit', owner, owner.headSha);
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('missing');
      t.journal.begin('push', owner);
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('not confirmed');
    } finally {
      t.close();
    }
  });

  it('blocks a foreign workspace claiming the same managed branch', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      const foreign = identity('foreign', {
        operationKey: 'different-reviewed-operation',
      });
      t.journal.begin('commit', foreign);
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('another workspace');
      expect(t.journal.get('foreign', 'commit')).toMatchObject({
        state: 'intent',
        receiptSha: null,
      });
      expect(t.journal.get('primary', 'push')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });

  it('blocks a duplicate operation key even when its branch differs', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      const foreign = identity('foreign', { branch: anotherBranch });
      t.journal.begin('commit', foreign);
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('another workspace');
      expect(t.journal.get('foreign', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('does not allow confirmed foreign receipts to bypass exclusive ownership', () => {
    const t = setup();
    try {
      const owner = identity();
      const foreign = identity('foreign', {
        operationKey: 'foreign-reviewed-operation',
      });
      confirmBoth(t.journal, owner);
      confirmBoth(t.journal, foreign);
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('another workspace');
      expect(() => t.journal.assertReadyForDraft(foreign)).toThrow('another workspace');
    } finally {
      t.close();
    }
  });

  it('does not block a different operation on a different managed branch', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      t.journal.begin(
        'commit',
        identity('foreign', {
          operationKey: 'foreign-reviewed-operation',
          branch: anotherBranch,
        }),
      );
      expect(() => t.journal.assertReadyForDraft(owner)).not.toThrow();
    } finally {
      t.close();
    }
  });

  it('does not modify existing intents or receipts when a collision is found', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      t.journal.begin('commit', identity('foreign'));
      const before = t.db.prepare('SELECT * FROM delivery_git_transfers ORDER BY workspace_id, stage').all();
      expect(() => t.journal.assertReadyForDraft(owner)).toThrow('another workspace');
      const after = t.db.prepare('SELECT * FROM delivery_git_transfers ORDER BY workspace_id, stage').all();
      expect(after).toEqual(before);
    } finally {
      t.close();
    }
  });

  it('preserves the conflict across independent SQLite connections and restart', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      t.journal.begin('commit', identity('foreign'));
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        expect(() => journal.assertReadyForDraft(owner)).toThrow('another workspace');
        expect(journal.get('foreign', 'commit')?.state).toBe('intent');
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });

  it('blocks a second Node process using the same durable SQLite journal', () => {
    const t = setup();
    try {
      const owner = identity();
      confirmBoth(t.journal, owner);
      t.journal.begin('commit', identity('foreign'));
      const script = [
        "import { DatabaseSync } from 'node:sqlite';",
        "import { DeliveryGitTransferJournal } from './src/server/delivery-git-transfer-journal.ts';",
        'const db = new DatabaseSync(process.argv[1]);',
        'const owner = JSON.parse(process.argv[2]);',
        "try { new DeliveryGitTransferJournal(db).assertReadyForDraft(owner); process.exit(43); }",
        "catch (error) { process.exit(String(error).includes('another workspace') ? 42 : 44); }",
      ].join(' ');
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          t.dbPath,
          JSON.stringify(owner),
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(child.status).toBe(42);
      expect(t.journal.get('primary', 'push')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });
});
