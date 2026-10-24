import type { DeliveryGitTransferIdentity, DeliveryGitTransferJournal } from './delivery-git-transfer-journal.js';
import type { DeliveryJournal } from './delivery-journal.js';
import {
  recoverDeliveryWorkspaceWithTransfers,
  type WorkspaceRecoveryContext,
} from './delivery-workspace-recovery.js';

export type RegisteredDeliveryWorkspace = Omit<WorkspaceRecoveryContext, 'journal'> & {
  transferIdentity: DeliveryGitTransferIdentity;
};

export type DeliveryStartupRecoveryResult = {
  workspaceId: string;
  publication: Awaited<ReturnType<typeof recoverDeliveryWorkspaceWithTransfers>>['publication'];
  commit: Awaited<ReturnType<typeof recoverDeliveryWorkspaceWithTransfers>>['commit'];
  push: Awaited<ReturnType<typeof recoverDeliveryWorkspaceWithTransfers>>['push'];
};

/**
 * Server-only startup orchestration for a TRUSTED registry of workspaces.
 *
 * The registry must come from persisted server-owned workspace records, never
 * from an HTTP request. All unresolved journal rows must have a registration.
 * Preflight is read-only and rejects the entire batch before any transition
 * when an identity is missing, duplicated or stale.
 *
 * Each workspace is then recovered under its normal common-Git-dir lease.
 * A failed lease or changed filesystem identity stops the batch; completed
 * transitions are monotonic and safe to revisit on the next startup.
 * This function never runs Git writes, GitHub requests or external retries.
 */
export async function recoverRegisteredDeliveryWorkspaces(input: {
  journal: DeliveryJournal;
  transferJournal: DeliveryGitTransferJournal;
  registrations: readonly RegisteredDeliveryWorkspace[];
}): Promise<DeliveryStartupRecoveryResult[]> {
  const registered = new Map<string, RegisteredDeliveryWorkspace>();
  for (const item of input.registrations) {
    if (
      !item.workspaceId ||
      !item.operationKey ||
      item.transferIdentity.workspaceId !== item.workspaceId ||
      item.transferIdentity.operationKey !== item.operationKey
    ) {
      throw new Error('Startup recovery registry contains an invalid operation identity.');
    }
    if (registered.has(item.workspaceId)) {
      throw new Error('Startup recovery registry contains a duplicate workspace.');
    }
    registered.set(item.workspaceId, item);
  }

  const unresolvedPublications = input.journal.listUnresolved();
  const unresolvedTransfers = input.transferJournal.listUnresolved();
  const pendingIds = new Set([
    ...unresolvedPublications.map((entry) => entry.workspaceId),
    ...unresolvedTransfers.map((entry) => entry.workspaceId),
  ]);
  const orderedIds = [...pendingIds].sort();

  // Validate every unresolved operation before touching any journal state.
  for (const workspaceId of orderedIds) {
    const registration = registered.get(workspaceId);
    if (!registration) {
      throw new Error('Unresolved delivery workspace has no trusted startup registration.');
    }
    const publication = input.journal.get(workspaceId);
    if (publication && publication.operationKey !== registration.operationKey) {
      throw new Error('Startup publication operation differs from the trusted registration.');
    }
    for (const stage of ['commit', 'push'] as const) {
      if (input.transferJournal.get(workspaceId, stage)) {
        input.transferJournal.assertOwned(stage, registration.transferIdentity);
      }
    }
    const push = input.transferJournal.get(workspaceId, 'push');
    if (push) {
      input.transferJournal.assertConfirmed('commit', registration.transferIdentity);
    }
  }

  const results: DeliveryStartupRecoveryResult[] = [];
  for (const workspaceId of orderedIds) {
    const registration = registered.get(workspaceId)!;
    const recovered = await recoverDeliveryWorkspaceWithTransfers({
      ...registration,
      journal: input.journal,
      transferJournal: input.transferJournal,
    });
    results.push({ workspaceId, ...recovered });
  }
  return results;
}
