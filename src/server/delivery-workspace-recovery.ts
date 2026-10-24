import { realpath } from 'node:fs/promises';
import type { DeliveryJournal, DeliveryJournalEntry } from './delivery-journal.js';
import type {
  DeliveryGitTransferEntry,
  DeliveryGitTransferIdentity,
  DeliveryGitTransferJournal,
} from './delivery-git-transfer-journal.js';
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
 * Verify both registered worktrees while holding the shared Git lease.
 * No journal state is touched before the ownership checks finish.
 */
async function withValidatedRecoveryLease<T>(
  context: Pick<WorkspaceRecoveryContext, 'repository' | 'worktree'>,
  action: () => Promise<T>,
): Promise<T> {
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
    return action();
  });
}

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
  return withValidatedRecoveryLease(context, async () =>
    context.journal.recoverWorkspace(context.workspaceId, context.operationKey),
  );
}

/**
 * Restart recovery of publication, commit and push stages under ONE lease.
 * Validate all present rows before changing any state. Confirmed receipts
 * survive recovery; interrupted intents become uncertain, never replayed.
 * All transitions are monotonic and idempotent across partial crashes.
 */
export async function recoverDeliveryWorkspaceWithTransfers(
  context: WorkspaceRecoveryContext & {
    transferJournal: DeliveryGitTransferJournal;
    transferIdentity: DeliveryGitTransferIdentity;
  },
): Promise<{
  publication: DeliveryJournalEntry | null;
  commit: DeliveryGitTransferEntry | null;
  push: DeliveryGitTransferEntry | null;
}> {
  const { workspaceId, operationKey, transferIdentity, transferJournal } = context;
  if (
    !workspaceId ||
    !operationKey ||
    transferIdentity.workspaceId !== workspaceId ||
    transferIdentity.operationKey !== operationKey
  ) {
    throw new Error('Startup recovery identity differs from the registered operation.');
  }
  return withValidatedRecoveryLease(context, async () => {
    const publication = context.journal.get(workspaceId);
    if (publication && publication.operationKey !== operationKey) {
      throw new Error('Recovery operation does not own the workspace.');
    }
    const commit = transferJournal.get(workspaceId, 'commit');
    const push = transferJournal.get(workspaceId, 'push');
    if (commit) transferJournal.assertOwned('commit', transferIdentity);
    if (push) transferJournal.assertOwned('push', transferIdentity);
    if (push && (!commit || commit.state !== 'confirmed')) {
      throw new Error('Push recovery requires the confirmed matching commit receipt.');
    }

    const recoveredPublication = context.journal.recoverWorkspace(workspaceId, operationKey);
    const recoveredCommit = commit
      ? transferJournal.recoverWorkspace('commit', transferIdentity)
      : null;
    const recoveredPush = push ? transferJournal.recoverWorkspace('push', transferIdentity) : null;
    return {
      publication: recoveredPublication,
      commit: recoveredCommit,
      push: recoveredPush,
    };
  });
}
