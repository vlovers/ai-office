import type { DeliveryGitTransferIdentity, DeliveryGitTransferJournal } from './delivery-git-transfer-journal.js';
import type { DeliveryJournal } from './delivery-journal.js';
import { recoverDeliveryWorkspaceWithTransfers } from './delivery-workspace-recovery.js';

type RepositoryIdentity = { path: string; gitDir: string };

/**
 * A trusted server registry supplies these values; never deserialize them
 * from a browser request or infer filesystem paths from journal contents.
 */
export type RegisteredDeliveryRecovery = {
  workspaceId: string;
  operationKey: string;
  repository: RepositoryIdentity;
  worktree: RepositoryIdentity;
  transferIdentity: DeliveryGitTransferIdentity;
};

export type DeliveryStartupRecoveryReport = {
  recovered: Array<{
    workspaceId: string;
    publication: 'absent' | 'reserved' | 'uncertain' | 'published';
    commit: 'absent' | 'intent' | 'uncertain' | 'confirmed';
    push: 'absent' | 'intent' | 'uncertain' | 'confirmed';
  }>;
  blocked: Array<{
    workspaceId: string;
    reason: 'conflicting-operation' | 'missing-registration' | 'identity-mismatch' | 'lease-or-recovery-failed';
  }>;
};

/**
 * Recover pending Delivery operations without a global SQL UPDATE.
 *
 * Inventory is read-only and combines both journals, including operations
 * which have no publication row. Each workspace is independently resolved
 * against the trusted registry, validated, and recovered under the same Git
 * lease used by normal publication and transfer operations.
 *
 * A missing/stale registration, mismatched operation, foreign worktree, lock
 * contention or SQLite failure blocks that workspace. Other workspaces are
 * not modified by its failure. Never expose underlying exception messages to
 * clients: they can contain local filesystem paths.
 *
 * This does not start a publisher, retry an external write, authenticate a
 * user or create an HTTP endpoint.
 */
export async function recoverRegisteredDeliveryOperations(
  journal: DeliveryJournal,
  transferJournal: DeliveryGitTransferJournal,
  resolveRegistered: (workspaceId: string) => Promise<RegisteredDeliveryRecovery | null>,
): Promise<DeliveryStartupRecoveryReport> {
  const operations = new Map<string, Set<string>>();
  const add = (workspaceId: string, operationKey: string) => {
    const keys = operations.get(workspaceId) ?? new Set<string>();
    keys.add(operationKey);
    operations.set(workspaceId, keys);
  };

  for (const entry of journal.listUnresolved()) add(entry.workspaceId, entry.operationKey);
  for (const entry of transferJournal.listUnresolved()) add(entry.workspaceId, entry.operationKey);

  const report: DeliveryStartupRecoveryReport = { recovered: [], blocked: [] };
  for (const workspaceId of [...operations.keys()].sort()) {
    const keys = operations.get(workspaceId)!;
    if (keys.size !== 1) {
      report.blocked.push({ workspaceId, reason: 'conflicting-operation' });
      continue;
    }
    const operationKey = [...keys][0]!;
    let registration: RegisteredDeliveryRecovery | null;
    try {
      registration = await resolveRegistered(workspaceId);
    } catch {
      report.blocked.push({ workspaceId, reason: 'missing-registration' });
      continue;
    }
    if (!registration) {
      report.blocked.push({ workspaceId, reason: 'missing-registration' });
      continue;
    }
    if (
      registration.workspaceId !== workspaceId ||
      registration.operationKey !== operationKey ||
      registration.transferIdentity?.workspaceId !== workspaceId ||
      registration.transferIdentity.operationKey !== operationKey ||
      !registration.repository?.path ||
      !registration.repository.gitDir ||
      !registration.worktree?.path ||
      !registration.worktree.gitDir
    ) {
      report.blocked.push({ workspaceId, reason: 'identity-mismatch' });
      continue;
    }
    try {
      const recovered = await recoverDeliveryWorkspaceWithTransfers({
        journal,
        transferJournal,
        workspaceId,
        operationKey,
        repository: registration.repository,
        worktree: registration.worktree,
        transferIdentity: registration.transferIdentity,
      });
      report.recovered.push({
        workspaceId,
        publication: recovered.publication?.state ?? 'absent',
        commit: recovered.commit?.state ?? 'absent',
        push: recovered.push?.state ?? 'absent',
      });
    } catch {
      report.blocked.push({ workspaceId, reason: 'lease-or-recovery-failed' });
    }
  }
  return report;
}
