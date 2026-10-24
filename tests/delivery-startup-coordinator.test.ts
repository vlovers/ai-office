import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import {
  recoverRegisteredDeliveryWorkspaces,
  type RegisteredDeliveryWorkspace,
} from '../src/server/delivery-startup-coordinator.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';

function gitRepo() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-startup-')));
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', path]);
  execFileSync('/usr/bin/git', ['-C', path, 'config', 'user.name', 'AI Office Test']);
  execFileSync('/usr/bin/git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(path, 'README'), 'fixture\n');
  execFileSync('/usr/bin/git', ['-C', path, 'add', 'README']);
  execFileSync('/usr/bin/git', ['-C', path, 'commit', '-qm', 'fixture']);
  return { path, gitDir: realpathSync(join(path, '.git')) };
}

function registration(
  workspaceId: string,
  repository: ReturnType<typeof gitRepo>,
): RegisteredDeliveryWorkspace {
  return {
    workspaceId,
    operationKey: `operation-${workspaceId}`,
    repository,
    worktree: repository,
    transferIdentity: {
      workspaceId,
      operationKey: `operation-${workspaceId}`,
      destination: 'https://github.com/vlovers/ai-office',
      branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    },
  };
}

describe('trusted delivery startup coordinator', () => {
  it('recovers all unresolved workspaces in stable order without replaying writes', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      const one = registration('workspace-1', repository);
      const two = registration('workspace-2', repository);
      journal.reserve(two.workspaceId, two.operationKey);
      journal.reserve(one.workspaceId, one.operationKey);
      transferJournal.begin('commit', one.transferIdentity);
      transferJournal.confirmVerified('commit', one.transferIdentity, one.transferIdentity.headSha);
      transferJournal.begin('push', one.transferIdentity);
      transferJournal.begin('commit', two.transferIdentity);

      const input = { journal, transferJournal, registrations: [two, one] };
      const results = await recoverRegisteredDeliveryWorkspaces(input);
      expect(results.map((result) => result.workspaceId)).toEqual(['workspace-1', 'workspace-2']);
      expect(results[0]!.publication?.state).toBe('uncertain');
      expect(results[0]!.commit?.state).toBe('confirmed');
      expect(results[0]!.push?.state).toBe('uncertain');
      expect(results[1]!.commit?.state).toBe('uncertain');
      expect(journal.get('workspace-2')?.state).toBe('uncertain');
      expect(await recoverRegisteredDeliveryWorkspaces(input)).toEqual(results);
      expect(() => transferJournal.begin('push', one.transferIdentity)).toThrow('already exists');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('rejects missing registration before changing any workspace', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      const one = registration('workspace-1', repository);
      const two = registration('workspace-2', repository);
      journal.reserve(one.workspaceId, one.operationKey);
      journal.reserve(two.workspaceId, two.operationKey);
      await expect(
        recoverRegisteredDeliveryWorkspaces({
          journal,
          transferJournal,
          registrations: [one],
        }),
      ).rejects.toThrow('no trusted startup registration');
      expect(journal.get(one.workspaceId)?.state).toBe('reserved');
      expect(journal.get(two.workspaceId)?.state).toBe('reserved');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('rejects duplicate, stale and forged transfer identities before recovery', async () => {
    const repository = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      const one = registration('workspace-1', repository);
      const two = registration('workspace-2', repository);
      journal.reserve(one.workspaceId, one.operationKey);
      journal.reserve(two.workspaceId, two.operationKey);
      transferJournal.begin('commit', two.transferIdentity);
      const run = (registrations: RegisteredDeliveryWorkspace[]) =>
        recoverRegisteredDeliveryWorkspaces({ journal, transferJournal, registrations });

      const stale = {
        ...two,
        operationKey: 'stale',
        transferIdentity: { ...two.transferIdentity, operationKey: 'stale' },
      };
      const forged = {
        ...two,
        transferIdentity: {
          ...two.transferIdentity,
          destination: 'https://github.com/attacker/repo',
        },
      };
      await expect(run([one, one, two])).rejects.toThrow('duplicate workspace');
      await expect(run([one, stale])).rejects.toThrow('differs from the trusted registration');
      await expect(run([one, forged])).rejects.toThrow('belongs to another operation');
      expect(journal.get(one.workspaceId)?.state).toBe('reserved');
      expect(journal.get(two.workspaceId)?.state).toBe('reserved');
      expect(transferJournal.get(two.workspaceId, 'commit')?.state).toBe('intent');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('fails closed on foreign worktrees and preserves unresolved journal state', async () => {
    const repository = gitRepo();
    const foreign = gitRepo();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      const transferJournal = new DeliveryGitTransferJournal(db);
      const one = registration('workspace-1', repository);
      journal.reserve(one.workspaceId, one.operationKey);
      await expect(
        recoverRegisteredDeliveryWorkspaces({
          journal,
          transferJournal,
          registrations: [{ ...one, worktree: foreign }],
        }),
      ).rejects.toThrow('does not belong to the registered repository');
      expect(journal.get(one.workspaceId)?.state).toBe('reserved');
    } finally {
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(foreign.path, { recursive: true, force: true });
    }
  });

  it('does not steal a held publication lease or change the journal', async () => {
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
      const transferJournal = new DeliveryGitTransferJournal(db);
      const one = registration('workspace-1', repository);
      journal.reserve(one.workspaceId, one.operationKey);
      const holder = withDeliveryRepositoryLease(repository, repository.gitDir, async () => {
        notifyHeld();
        await held;
      });
      await acquired;
      await expect(
        recoverRegisteredDeliveryWorkspaces({
          journal,
          transferJournal,
          registrations: [one],
        }),
      ).rejects.toThrow('Resource is locked');
      expect(journal.get(one.workspaceId)?.state).toBe('reserved');
      releaseHeld();
      await holder;
    } finally {
      releaseHeld();
      db.close();
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it('recovers persisted SQLite intents after a process restart', async () => {
    const repository = gitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-startup-db-'));
    const path = join(dir, 'delivery.sqlite');
    try {
      const one = registration('workspace-1', repository);
      const first = new DatabaseSync(path);
      new DeliveryJournal(first).reserve(one.workspaceId, one.operationKey);
      new DeliveryGitTransferJournal(first).begin('commit', one.transferIdentity);
      first.close();

      const second = new DatabaseSync(path);
      const journal = new DeliveryJournal(second);
      const transferJournal = new DeliveryGitTransferJournal(second);
      const result = await recoverRegisteredDeliveryWorkspaces({
        journal,
        transferJournal,
        registrations: [one],
      });
      expect(result[0]!.publication?.state).toBe('uncertain');
      expect(result[0]!.commit?.state).toBe('uncertain');
      second.close();

      const third = new DatabaseSync(path);
      expect(new DeliveryJournal(third).get(one.workspaceId)?.state).toBe('uncertain');
      expect(new DeliveryGitTransferJournal(third).get(one.workspaceId, 'commit')?.state).toBe(
        'uncertain',
      );
      third.close();
    } finally {
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
