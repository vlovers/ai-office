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
  const root = mkdtempSync(join(tmpdir(), 'ai-office-transfer-stage-'));
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

function insertPush(db: DatabaseSync, changes: Partial<DeliveryGitTransferIdentity> = {}) {
  const value = { ...identity, ...changes };
  return db
    .prepare(
      'INSERT INTO delivery_git_transfers ' +
        '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha) ' +
        "VALUES (?, 'push', ?, ?, ?, ?, ?, 'intent', NULL)",
    )
    .run(
      value.workspaceId,
      value.operationKey,
      value.destination,
      value.branch,
      value.headSha,
      value.baseSha,
    );
}

/** Exercise SQLite guards from a process that does not import our journal class. */
function externalSql(path: string, sql: string, values: string[] = []) {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(process.argv[1]);',
    'try { db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3])); process.exit(0); }',
    'catch (error) { process.stderr.write(String(error)); process.exit(42); }',
  ].join(' ');
  return spawnSync(process.execPath, ['-e', script, path, sql, JSON.stringify(values)], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

function confirmCommit(journal: DeliveryGitTransferJournal) {
  journal.begin('commit', identity);
  journal.confirmVerified('commit', identity, identity.headSha);
}

describe('SQLite cross-stage Git transfer invariants', () => {
  it('rejects direct push reservation without any commit intent', () => {
    const t = setup();
    try {
      expect(() => insertPush(t.db)).toThrow('matching confirmed commit');
      expect(t.journal.get(identity.workspaceId, 'push')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('rejects push reservation while commit is intent or uncertain', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      expect(() => insertPush(t.db)).toThrow('matching confirmed commit');
      t.journal.markUncertain('commit', identity);
      expect(() => insertPush(t.db)).toThrow('matching confirmed commit');
      expect(t.journal.get(identity.workspaceId, 'push')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('allows a push intent and receipt after an exact confirmed commit', () => {
    const t = setup();
    try {
      confirmCommit(t.journal);
      expect(t.journal.begin('push', identity).state).toBe('intent');
      expect(t.journal.confirmVerified('push', identity, identity.headSha)).toMatchObject({
        state: 'confirmed',
        receiptSha: identity.headSha,
      });
      expect(() => t.journal.assertReadyForDraft(identity)).not.toThrow();
    } finally {
      t.close();
    }
  });

  it('rejects direct push inserts that change any part of the reviewed commit identity', () => {
    const t = setup();
    try {
      confirmCommit(t.journal);
      const variants: Partial<DeliveryGitTransferIdentity>[] = [
        { workspaceId: 'foreign-workspace' },
        { operationKey: 'foreign-operation' },
        { destination: 'https://github.com/foreign/repo' },
        { branch: 'ai-office/22345678-1234-1234-1234-123456789abc' },
        { headSha: 'c'.repeat(40) },
        { baseSha: 'd'.repeat(40) },
      ];
      for (const variant of variants) {
        expect(() => insertPush(t.db, variant)).toThrow();
      }
      expect(t.journal.get(identity.workspaceId, 'push')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('refuses direct push confirmation if a legacy commit receipt was corrupted', () => {
    const t = setup();
    try {
      confirmCommit(t.journal);
      t.journal.begin('push', identity);
      // Simulate pre-upgrade damage; production must never drop this trigger.
      t.db.exec('DROP TRIGGER delivery_git_transfers_monotonic_receipt');
      t.db
        .prepare(
          "UPDATE delivery_git_transfers SET state='uncertain', receipt_sha=NULL WHERE stage='commit'",
        )
        .run();
      expect(() =>
        t.db
          .prepare(
            "UPDATE delivery_git_transfers SET state='confirmed', receipt_sha=? WHERE stage='push'",
          )
          .run(identity.headSha),
      ).toThrow('matching confirmed commit');
      expect(t.journal.get(identity.workspaceId, 'push')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('refuses direct deletion of intent and confirmed receipts', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      expect(() => t.db.exec("DELETE FROM delivery_git_transfers WHERE stage='commit'")).toThrow(
        'cannot be deleted',
      );
      t.journal.confirmVerified('commit', identity, identity.headSha);
      t.journal.begin('push', identity);
      t.journal.confirmVerified('push', identity, identity.headSha);
      expect(() => t.db.exec('DELETE FROM delivery_git_transfers')).toThrow('cannot be deleted');
      expect(t.db.prepare('SELECT count(*) AS n FROM delivery_git_transfers').get()?.n).toBe(2);
    } finally {
      t.close();
    }
  });

  it('keeps stage and deletion guards across a separate SQLite connection and restart', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      const second = new DatabaseSync(t.path);
      try {
        expect(() => insertPush(second)).toThrow('matching confirmed commit');
        expect(() => second.exec('DELETE FROM delivery_git_transfers')).toThrow(
          'cannot be deleted',
        );
      } finally {
        second.close();
      }
      const restarted = new DatabaseSync(t.path);
      try {
        const journal = new DeliveryGitTransferJournal(restarted);
        expect(() => insertPush(restarted)).toThrow('matching confirmed commit');
        expect(journal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
      } finally {
        restarted.close();
      }
    } finally {
      t.close();
    }
  });

  it('blocks direct SQL replay attempts from an independent Node process', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      const script = [
        "const { DatabaseSync } = require('node:sqlite');",
        'const db = new DatabaseSync(process.argv[1]);',
        'try { db.exec("DELETE FROM delivery_git_transfers"); process.exit(43); }',
        "catch (error) { process.exit(String(error).includes('cannot be deleted') ? 42 : 44); }",
      ].join(' ');
      const child = spawnSync(process.execPath, ['-e', script, t.path], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(child.status).toBe(42);
      expect(t.journal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('atomically rejects competing operation and branch owners from independent processes', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      const insert =
        'INSERT INTO delivery_git_transfers ' +
        '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha) ' +
        "VALUES (?, 'commit', ?, ?, ?, ?, ?, 'intent', NULL)";
      const attempts = [
        [
          'foreign-workspace',
          identity.operationKey,
          identity.destination,
          'ai-office/22345678-1234-1234-1234-123456789abc',
          identity.headSha,
          identity.baseSha,
        ],
        [
          'foreign-workspace',
          'foreign-operation',
          'https://github.com/VLOVERS/AI-OFFICE',
          identity.branch,
          identity.headSha,
          identity.baseSha,
        ],
      ];
      for (const values of attempts) {
        const contender = externalSql(t.path, insert, values);
        expect(contender.status, contender.stderr).toBe(42);
        expect(contender.stderr).toContain('belongs to another workspace');
      }
      expect(t.db.prepare('SELECT count(*) AS n FROM delivery_git_transfers').get()?.n).toBe(1);
      expect(t.journal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('enforces push prerequisites and prevents replay across process boundaries', () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      const insert =
        'INSERT INTO delivery_git_transfers ' +
        '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha) ' +
        "VALUES (?, 'push', ?, ?, ?, ?, ?, 'intent', NULL)";
      const values = [
        identity.workspaceId,
        identity.operationKey,
        identity.destination,
        identity.branch,
        identity.headSha,
        identity.baseSha,
      ];
      const premature = externalSql(t.path, insert, values);
      expect(premature.status, premature.stderr).toBe(42);
      expect(premature.stderr).toContain('matching confirmed commit');
      t.journal.confirmVerified('commit', identity, identity.headSha);
      const reserved = externalSql(t.path, insert, values);
      expect(reserved.status, reserved.stderr).toBe(0);
      const replay = externalSql(t.path, insert, values);
      expect(replay.status, replay.stderr).toBe(42);
      expect(replay.stderr).toContain('already exists');
      expect(t.journal.get(identity.workspaceId, 'push')).toMatchObject({
        state: 'intent',
        receiptSha: null,
      });
    } finally {
      t.close();
    }
  });

  it('rejects forged receipts, identity rewrites, REPLACE and deletion by raw external SQL', () => {
    const t = setup();
    try {
      confirmCommit(t.journal);
      t.journal.begin('push', identity);
      t.journal.confirmVerified('push', identity, identity.headSha);
      const before = t.db.prepare('SELECT * FROM delivery_git_transfers ORDER BY stage').all();
      const attempts: Array<{ sql: string; values: string[] }> = [
        {
          sql:
            'INSERT OR REPLACE INTO delivery_git_transfers ' +
            '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha) ' +
            "VALUES (?, 'commit', ?, ?, ?, ?, ?, 'intent', NULL)",
          values: [
            identity.workspaceId,
            identity.operationKey,
            identity.destination,
            identity.branch,
            identity.headSha,
            identity.baseSha,
          ],
        },
        {
          sql:
            "UPDATE delivery_git_transfers SET state='uncertain', receipt_sha=NULL WHERE stage='push'",
          values: [],
        },
        {
          sql: "UPDATE delivery_git_transfers SET receipt_sha=? WHERE stage='commit'",
          values: ['f'.repeat(40)],
        },
        {
          sql: 'UPDATE delivery_git_transfers SET head_sha=? WHERE stage=?',
          values: ['f'.repeat(40), 'push'],
        },
        {
          sql: 'DELETE FROM delivery_git_transfers WHERE stage=?',
          values: ['commit'],
        },
        {
          sql:
            'INSERT INTO delivery_git_transfers ' +
            '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha) ' +
            "VALUES (?, 'commit', ?, ?, ?, ?, ?, 'confirmed', ?)",
          values: [
            'forged-workspace',
            'forged-operation',
            identity.destination,
            'ai-office/32345678-1234-1234-1234-123456789abc',
            identity.headSha,
            identity.baseSha,
            identity.headSha,
          ],
        },
      ];
      for (const attempt of attempts) {
        const child = externalSql(t.path, attempt.sql, attempt.values);
        expect(child.status, child.stderr).toBe(42);
        expect(t.db.prepare('SELECT * FROM delivery_git_transfers ORDER BY stage').all()).toEqual(
          before,
        );
      }
      expect(() => t.journal.assertReadyForDraft(identity)).not.toThrow();
    } finally {
      t.close();
    }
  });

  it('temporary Prettier diagnostic for the cross-process suite', async () => {
    const prettier = await import('prettier');
    const { readFileSync } = await import('node:fs');
    const path = 'tests/delivery-git-transfer-stage-invariants.test.ts';
    const current = readFileSync(path, 'utf8');
    const expected = await prettier.format(current, {
      ...(await prettier.resolveConfig(path)),
      filepath: path,
    });
    const diff = spawnSync('diff', ['-u', path, '-'], {
      input: expected,
      encoding: 'utf8',
    });
    if (diff.status === 1) throw new Error(diff.stdout.slice(0, 10000));
  });

  it('retains a pre-upgrade orphaned push without adopting or deleting it', () => {
    const t = setup();
    try {
      t.db.exec('DROP TRIGGER delivery_git_transfers_push_requires_commit_insert');
      insertPush(t.db);
      const before = t.db.prepare('SELECT * FROM delivery_git_transfers').all();
      const reopened = new DatabaseSync(t.path);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        expect(journal.get(identity.workspaceId, 'push')?.state).toBe('intent');
        expect(() => journal.assertReadyForDraft(identity)).toThrow('missing');
        expect(reopened.prepare('SELECT * FROM delivery_git_transfers').all()).toEqual(before);
        expect(() => insertPush(reopened)).toThrow();
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });
});
