import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferIdentity,
} from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';
import { recoverDeliveryWorkspace } from '../src/server/delivery-workspace-recovery.js';

const identity: DeliveryGitTransferIdentity = {
  workspaceId: 'workspace-1',
  operationKey: 'operation-a',
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
};

function gitRepo() {
  const path = mkdtempSync(join(tmpdir(), 'ai-office-recovery-'));
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', path]);
  execFileSync('/usr/bin/git', ['-C', path, 'config', 'user.name', 'AI Office Test']);
  execFileSync('/usr/bin/git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(path, 'README'), 'fixture\n');
  execFileSync('/usr/bin/git', ['-C', path, 'add', 'README']);
  execFileSync('/usr/bin/git', ['-C', path, 'commit', '-qm', 'fixture']);
  return { path, gitDir: realpathSync(join(path, '.git')) };
}

describe('durable commit/push transfer receipts', () => {
  it('requires confirmed commit before push, and both receipts before Draft PR', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryGitTransferJournal(db);
      expect(() => journal.begin('push', identity)).toThrow('missing');
      journal.begin('commit', identity);
      expect(() => journal.begin('commit', identity)).toThrow('already exists');
      expect(() => journal.begin('push', identity)).toThrow('not confirmed');
      expect(() => journal.assertReadyForDraft(identity)).toThrow('not confirmed');
      expect(() => journal.confirmVerified('commit', identity, 'c'.repeat(40))).toThrow(
        'does not match',
      );
      journal.confirmVerified('commit', identity, identity.headSha);
      journal.begin('push', identity);
      expect(() => journal.assertReadyForDraft(identity)).toThrow('not confirmed');
      journal.confirmVerified('push', identity, identity.headSha);
      expect(journal.assertReadyForDraft(identity)).toBeUndefined();
      expect(journal.confirmVerified('push', identity, identity.headSha).state).toBe('confirmed');
    } finally {
      db.close();
    }
  });

  it('persists ambiguous intents across SQLite restart without permitting replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-transfer-db-'));
    const path = join(dir, 'journal.sqlite');
    try {
      const db1 = new DatabaseSync(path);
      const first = new DeliveryGitTransferJournal(db1);
      first.begin('commit', identity);
      db1.close();

      const db2 = new DatabaseSync(path);
      const recovered = new DeliveryGitTransferJournal(db2);
      expect(recovered.recoverWorkspace('commit', identity).state).toBe('uncertain');
      expect(() => recovered.begin('commit', identity)).toThrow('already exists');
      expect(() => recovered.begin('commit', { ...identity, operationKey: 'forged' })).toThrow();
      expect(() => recovered.confirmVerified('commit', identity, '0'.repeat(40))).toThrow();
      expect(recovered.get(identity.workspaceId, 'commit')?.state).toBe('uncertain');
      recovered.confirmVerified('commit', identity, identity.headSha);
      expect(recovered.recoverWorkspace('commit', identity).state).toBe('confirmed');
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects wrong destination, branch, SHA and workspace receipts', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryGitTransferJournal(db);
      journal.begin('commit', identity);
      for (const changed of [
        { destination: 'https://github.com/attacker/repo' },
        { branch: 'ai-office/87654321-1234-1234-1234-123456789abc' },
        { headSha: 'c'.repeat(40) },
        { baseSha: 'd'.repeat(40) },
        { workspaceId: 'workspace-2' },
        { operationKey: 'replayed' },
      ]) {
        expect(() => journal.confirmVerified('commit', { ...identity, ...changed }, identity.headSha))
          .toThrow('missing or belongs');
      }
      expect(journal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
    } finally {
      db.close();
    }
  });

  it('never accepts an invalid repository or non-managed branch as intent', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryGitTransferJournal(db);
      for (const changed of [
        { destination: 'https://token@github.com/vlovers/ai-office' },
        { destination: 'https://evil.example/repo' },
        { branch: 'main' },
        { headSha: 'abc' },
        { workspaceId: '' },
      ]) {
        expect(() => journal.begin('commit', { ...identity, ...changed })).toThrow(
          'Invalid Git transfer identity',
        );
      }
      expect(journal.get(identity.workspaceId, 'commit')).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('shared-lease workspace recovery', () => {
  it('recovers only the requested workspace and preserves unrelated reservations', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-1', 'operation-a');
      journal.reserve('workspace-2', 'operation-b');
      const recovered = await recoverDeliveryWorkspace({
        journal,
        workspaceId: 'workspace-1',
        operationKey: 'operation-a',
        repository,
        worktree: repository,
      });
      expect(recovered?.state).toBe('uncertain');
      expect(journal.get('workspace-2')?.state).toBe('reserved');
      await expect(
        recoverDeliveryWorkspace({
          journal,
          workspaceId: 'workspace-1',
          operationKey: 'forged',
          repository,
          worktree: repository,
        }),
      ).rejects.toThrow('does not own');
      expect(journal.get('workspace-1')?.state).toBe('uncertain');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('rejects recovery while another publisher holds the common repository lease', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    let releaseHeld!: () => void;
    let notifyHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      notifyHeld = resolve;
    });
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-1', 'operation-a');
      const holder = withDeliveryRepositoryLease(repository, repository.gitDir, async () => {
        notifyHeld();
        await held;
      });
      await acquired;
      await expect(
        recoverDeliveryWorkspace({
          journal,
          workspaceId: 'workspace-1',
          operationKey: 'operation-a',
          repository,
          worktree: repository,
        }),
      ).rejects.toThrow('Resource is locked');
      expect(journal.get('workspace-1')?.state).toBe('reserved');
      releaseHeld();
      await holder;
      expect(
        (
          await recoverDeliveryWorkspace({
            journal,
            workspaceId: 'workspace-1',
            operationKey: 'operation-a',
            repository,
            worktree: repository,
          })
        )?.state,
      ).toBe('uncertain');
    } finally {
      releaseHeld();
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('rejects recovery with a foreign worktree without mutating the journal', async () => {
    const repository = gitRepo();
    const foreign = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-1', 'operation-a');
      await expect(
        recoverDeliveryWorkspace({
          journal,
          workspaceId: 'workspace-1',
          operationKey: 'operation-a',
          repository,
          worktree: foreign,
        }),
      ).rejects.toThrow('does not belong to the registered repository');
      expect(journal.get('workspace-1')?.state).toBe('reserved');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(foreign.path, { recursive: true, force: true });
    }
  });
});
