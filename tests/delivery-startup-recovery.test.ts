import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';
import { recoverDeliveryWorkspaceWithTransfers } from '../src/server/delivery-workspace-recovery.js';

const identity = {
  workspaceId: 'workspace-startup',
  operationKey: 'operation-startup',
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
};

function gitRepo() {
  const path = mkdtempSync(join(tmpdir(), 'ai-office-startup-'));
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', path]);
  execFileSync('/usr/bin/git', ['-C', path, 'config', 'user.name', 'AI Office Test']);
  execFileSync('/usr/bin/git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(path, 'README'), 'fixture\n');
  execFileSync('/usr/bin/git', ['-C', path, 'add', 'README']);
  execFileSync('/usr/bin/git', ['-C', path, 'commit', '-qm', 'fixture']);
  return { path, gitDir: realpathSync(join(path, '.git')) };
}

describe('scoped startup recovery across delivery journals', () => {
  it('recovers a push intent and publication reservation after SQLite restart', async () => {
    const repository = gitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-startup-db-'));
    const path = join(dir, 'delivery.sqlite');
    try {
      const db1 = new DatabaseSync(path);
      const publications1 = new DeliveryJournal(db1);
      const transfers1 = new DeliveryGitTransferJournal(db1);
      publications1.reserve(identity.workspaceId, identity.operationKey);
      publications1.reserve('unrelated', 'other-operation');
      transfers1.begin('commit', identity);
      transfers1.confirmVerified('commit', identity, identity.headSha);
      transfers1.begin('push', identity);
      db1.close();

      const db2 = new DatabaseSync(path);
      try {
        const journal = new DeliveryJournal(db2);
        const transferJournal = new DeliveryGitTransferJournal(db2);
        const context = {
          journal,
          transferJournal,
          transferIdentity: identity,
          workspaceId: identity.workspaceId,
          operationKey: identity.operationKey,
          repository,
          worktree: repository,
        };
        const recovered = await recoverDeliveryWorkspaceWithTransfers(context);
        expect(recovered.publication?.state).toBe('uncertain');
        expect(recovered.commit?.state).toBe('confirmed');
        expect(recovered.push?.state).toBe('uncertain');
        expect(journal.get('unrelated')?.state).toBe('reserved');
        expect(() => transferJournal.begin('push', identity)).toThrow('already exists');
        expect((await recoverDeliveryWorkspaceWithTransfers(context)).push?.state).toBe(
          'uncertain',
        );
      } finally {
        db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('recovers a commit intent even when publication was not reserved', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      transferJournal.begin('commit', identity);
      const result = await recoverDeliveryWorkspaceWithTransfers({
        journal,
        transferJournal,
        transferIdentity: identity,
        workspaceId: identity.workspaceId,
        operationKey: identity.operationKey,
        repository,
        worktree: repository,
      });
      expect(result.publication).toBeNull();
      expect(result.commit?.state).toBe('uncertain');
      expect(result.push).toBeNull();
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('rejects mismatched transfer identity before changing any journal row', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      journal.reserve(identity.workspaceId, identity.operationKey);
      transferJournal.begin('commit', identity);
      await expect(
        recoverDeliveryWorkspaceWithTransfers({
          journal,
          transferJournal,
          transferIdentity: {
            ...identity,
            branch: 'ai-office/87654321-1234-1234-1234-123456789abc',
          },
          workspaceId: identity.workspaceId,
          operationKey: identity.operationKey,
          repository,
          worktree: repository,
        }),
      ).rejects.toThrow('belongs to another operation');
      expect(journal.get(identity.workspaceId)?.state).toBe('reserved');
      expect(transferJournal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('rejects a foreign worktree without changing either journal', async () => {
    const repository = gitRepo();
    const foreign = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      journal.reserve(identity.workspaceId, identity.operationKey);
      transferJournal.begin('commit', identity);
      await expect(
        recoverDeliveryWorkspaceWithTransfers({
          journal,
          transferJournal,
          transferIdentity: identity,
          workspaceId: identity.workspaceId,
          operationKey: identity.operationKey,
          repository,
          worktree: foreign,
        }),
      ).rejects.toThrow('does not belong');
      expect(journal.get(identity.workspaceId)?.state).toBe('reserved');
      expect(transferJournal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(foreign.path, { recursive: true, force: true });
    }
  });

  it('fails closed if another publisher holds the shared lease', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      journal.reserve(identity.workspaceId, identity.operationKey);
      transferJournal.begin('commit', identity);
      const holder = withDeliveryRepositoryLease(repository, repository.gitDir, async () => {
        acquired();
        await held;
      });
      await entered;
      await expect(
        recoverDeliveryWorkspaceWithTransfers({
          journal,
          transferJournal,
          transferIdentity: identity,
          workspaceId: identity.workspaceId,
          operationKey: identity.operationKey,
          repository,
          worktree: repository,
        }),
      ).rejects.toThrow('Resource is locked');
      expect(journal.get(identity.workspaceId)?.state).toBe('reserved');
      expect(transferJournal.get(identity.workspaceId, 'commit')?.state).toBe('intent');
      release();
      await holder;
    } finally {
      release();
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });
});
