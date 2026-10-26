import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';

const url = 'https://github.com/vlovers/ai-office/pull/123';

describe('durable publication SQLite invariants', () => {
  it('requires a receipt-free reserved intent even for direct SQL writers', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const insert = db.prepare(
        'INSERT INTO delivery_journal (workspace_id, operation_key, state, pull_request_url) VALUES (?, ?, ?, ?)',
      );
      expect(() => insert.run('workspace-a', 'op-a', 'published', url)).toThrow(
        'receipt-free intent',
      );
      expect(() => insert.run('workspace-a', 'op-a', 'uncertain', null)).toThrow(
        'receipt-free intent',
      );
      expect(() => insert.run('workspace-a', 'op-a', 'reserved', url)).toThrow(
        'receipt-free intent',
      );
      expect(journal.get('workspace-a')).toBeNull();
      expect(journal.reserve('workspace-a', 'op-a').state).toBe('reserved');
    } finally {
      db.close();
    }
  });

  it('does not permit direct SQL to reassign a publication identity', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-a', 'op-a');
      expect(() => db.exec("UPDATE delivery_journal SET workspace_id='workspace-b'")).toThrow(
        'identity is immutable',
      );
      expect(() => db.exec("UPDATE delivery_journal SET operation_key='op-b'")).toThrow(
        'identity is immutable',
      );
      expect(journal.get('workspace-a')?.operationKey).toBe('op-a');
      expect(journal.get('workspace-b')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('allows scoped recovery and GET-verified confirmation without resetting uncertainty', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-a', 'op-a');
      expect(journal.recoverWorkspace('workspace-a', 'op-a')?.state).toBe('uncertain');
      expect(journal.markUncertain('workspace-a', 'op-a')?.state).toBe('uncertain');
      expect(() => journal.reserve('workspace-a', 'op-a')).toThrow('already exists');
      expect(() =>
        db.exec("UPDATE delivery_journal SET state='reserved' WHERE workspace_id='workspace-a'"),
      ).toThrow('advance monotonically');
      expect(journal.confirmUncertain('workspace-a', 'op-a', url).state).toBe('published');
      expect(journal.publish('workspace-a', 'op-a', url).pullRequestUrl).toBe(url);
    } finally {
      db.close();
    }
  });

  it('rejects confirmed receipt replacement, downgrade and deletion by direct SQL', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-a', 'op-a');
      journal.publish('workspace-a', 'op-a', url);
      expect(() =>
        db.exec(
          "UPDATE delivery_journal SET pull_request_url='https://github.com/vlovers/ai-office/pull/456'",
        ),
      ).toThrow('advance monotonically');
      expect(() =>
        db.exec("UPDATE delivery_journal SET state='uncertain', pull_request_url=NULL"),
      ).toThrow('advance monotonically');
      expect(() => db.exec('DELETE FROM delivery_journal')).toThrow('cannot be deleted');
      expect(journal.get('workspace-a')).toEqual({
        workspaceId: 'workspace-a',
        operationKey: 'op-a',
        state: 'published',
        pullRequestUrl: url,
      });
    } finally {
      db.close();
    }
  });

  it('atomically rejects a foreign operation owner on independent SQLite connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-publication-integrity-'));
    const file = join(directory, 'delivery.sqlite');
    const first = new DatabaseSync(file);
    const second = new DatabaseSync(file);
    try {
      const owner = new DeliveryJournal(first);
      const competitor = new DeliveryJournal(second);
      owner.reserve('workspace-a', 'shared-operation');
      expect(() => competitor.reserve('workspace-b', 'shared-operation')).toThrow(
        'belongs to another workspace',
      );
      expect(owner.get('workspace-a')?.state).toBe('reserved');
      expect(competitor.get('workspace-b')).toBeNull();
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enforces durable receipts against a separate Node process after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-publication-restart-'));
    const file = join(directory, 'delivery.sqlite');
    try {
      const db = new DatabaseSync(file);
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-a', 'op-a');
      journal.markUncertain('workspace-a', 'op-a');
      db.close();

      const script = [
        "import { DatabaseSync } from 'node:sqlite';",
        'const db = new DatabaseSync(process.argv[1]);',
        'let blocked = 0;',
        'for (const sql of [',
        `  "UPDATE delivery_journal SET state='reserved' WHERE workspace_id='workspace-a'",`,
        `  "DELETE FROM delivery_journal WHERE workspace_id='workspace-a'",`,
        `  "INSERT INTO delivery_journal (workspace_id, operation_key, state, pull_request_url) VALUES ('workspace-b', 'op-a', 'reserved', NULL')",`,
        ']) { try { db.exec(sql); } catch { blocked++; } }',
        'db.close();',
        'if (blocked !== 3) process.exitCode = 1;',
      ].join('\n');
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], {
        encoding: 'utf8',
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const reopened = new DatabaseSync(file);
      try {
        const recovered = new DeliveryJournal(reopened);
        expect(recovered.get('workspace-a')?.state).toBe('uncertain');
        expect(recovered.get('workspace-b')).toBeNull();
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an ambiguous publication after a child-process crash and forbids replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-draft-crash-'));
    const file = join(directory, 'delivery.sqlite');
    try {
      const first = new DatabaseSync(file);
      const journal = new DeliveryJournal(first);
      journal.reserve('workspace-crash', 'operation-crash');
      first.close();

      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          [
            "import { DatabaseSync } from 'node:sqlite';",
            'const db = new DatabaseSync(process.argv[1]);',
            "db.exec(\"UPDATE delivery_journal SET state='uncertain' WHERE workspace_id='workspace-crash'\");",
            'db.close();',
            "process.kill(process.pid, 'SIGKILL');",
          ].join('\n'),
          file,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(child.signal).toBe('SIGKILL');

      const reopened = new DatabaseSync(file);
      try {
        const recovered = new DeliveryJournal(reopened);
        expect(recovered.get('workspace-crash')).toMatchObject({
          state: 'uncertain',
          pullRequestUrl: null,
        });
        expect(() => recovered.reserve('workspace-crash', 'operation-crash')).toThrow(
          'already exists',
        );
        expect(recovered.confirmUncertain('workspace-crash', 'operation-crash', url)).toMatchObject({
          state: 'published',
          pullRequestUrl: url,
        });
        expect(() => recovered.reserve('workspace-crash', 'operation-crash')).toThrow(
          'already exists',
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks INSERT OR REPLACE replay of confirmed publication and Git transfer receipts', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const publications = new DeliveryJournal(db);
      const transfers = new DeliveryGitTransferJournal(db);
      publications.reserve('workspace-a', 'op-a');
      publications.publish('workspace-a', 'op-a', url);
      const identity = {
        workspaceId: 'workspace-a',
        operationKey: 'op-a',
        destination: 'https://github.com/vlovers/ai-office',
        branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
      };
      transfers.begin('commit', identity);
      transfers.confirmVerified('commit', identity, identity.headSha);
      transfers.begin('push', identity);
      transfers.confirmVerified('push', identity, identity.headSha);

      // SQLite REPLACE otherwise deletes the old row without firing a
      // DELETE trigger when recursive_triggers is disabled (the default).
      expect(() =>
        db
          .prepare("INSERT OR REPLACE INTO delivery_journal VALUES (?, ?, 'reserved', NULL)")
          .run('workspace-a', 'op-a'),
      ).toThrow('already exists');
      const replaceTransfer = db.prepare(
        `INSERT OR REPLACE INTO delivery_git_transfers
         (workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', NULL)`,
      );
      for (const stage of ['commit', 'push']) {
        expect(() =>
          replaceTransfer.run(
            identity.workspaceId,
            stage,
            identity.operationKey,
            identity.destination,
            identity.branch,
            identity.headSha,
            identity.baseSha,
          ),
        ).toThrow('already exists');
      }
      expect(publications.get('workspace-a')?.state).toBe('published');
      expect(transfers.get('workspace-a', 'commit')?.state).toBe('confirmed');
      expect(transfers.get('workspace-a', 'push')?.state).toBe('confirmed');
    } finally {
      db.close();
    }
  });

  it('preserves conflicting pre-upgrade rows and fails closed on legacy ownership', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE delivery_journal (
        workspace_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        pull_request_url TEXT
      )`);
      db.prepare("INSERT INTO delivery_journal VALUES (?, ?, 'reserved', NULL)").run(
        'workspace-a',
        'legacy-operation',
      );
      db.prepare("INSERT INTO delivery_journal VALUES (?, ?, 'uncertain', NULL)").run(
        'workspace-b',
        'legacy-operation',
      );
      const journal = new DeliveryJournal(db);
      expect(() => journal.get('workspace-a')).toThrow('belongs to another workspace');
      expect(() => journal.get('workspace-b')).toThrow('belongs to another workspace');
      expect(() => journal.reserve('workspace-c', 'legacy-operation')).toThrow(
        'belongs to another workspace',
      );
      const count = db.prepare('SELECT COUNT(*) AS total FROM delivery_journal').get();
      expect(count?.total).toBe(2);
    } finally {
      db.close();
    }
  });
});
