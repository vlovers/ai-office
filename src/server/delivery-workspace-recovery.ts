import { realpath } from 'node:fs/promises';
import type { DeliveryJournal, DeliveryJournalEntry } from './delivery-journal.js';
import { withDeliveryRepositoryLease } from './delivery-publication-lease.js';
import { git, revalidateRepository } from './repositories.js';

type RepositoryIdentity = { path: string; gitDir: string };

export type WorkspaceRecoveryContext = {
  journal: DeliveryJournal;
  workspaceId: string;
  operationKey: string;
  repository: RepositoryIdentity;
  worktree: RepositoryIdentity;
};

/**
 * Recovery is scoped to the exact registered worktree and operation.
 * Never scan or update all workspaces during multi-process startup.
 * The same common-Git-dir lock serializes this with Draft PR publication.
 */
export async function recoverDeliveryWorkspace(
  context: WorkspaceRecoveryContext,
): Promise<DeliveryJournalEntry | null> {
  if (!context.workspaceId || !context.operationKey) {
    throw new Error('Workspace recovery requires a durable operation identity.');
  }
  return withDeliveryRepositoryLease(context.repository, context.worktree.gitDir, async () => {
    const repository = await revalidateRepository(context.repository);
    const worktree = await revalidateRepository(context.worktree);
    if (
      repository.path !== context.repository.path ||
      repository.gitDir !== context.repository.gitDir ||
      worktree.path !== context.worktree.path ||
      worktree.gitDir !== context.worktree.gitDir
    ) {
      throw new Error('Workspace identity changed before recovery.');
    }
    const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const commonRepository = await realpath((await git(repository.path, commonArgs)).trim());
    const commonWorktree = await realpath((await git(worktree.path, commonArgs)).trim());
    if (commonRepository !== commonWorktree) {
      throw new Error('Recovery worktree does not belong to the registered repository.');
    }
    return context.journal.recoverWorkspace(context.workspaceId, context.operationKey);
  });
}
