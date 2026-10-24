import type { DeliveryJournalEntry, DeliveryJournal } from './delivery-journal.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import { withPublicationLease } from './delivery-publication-lease.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import {
  reconcilePublicationCandidates,
  type RemoteDraftCandidate,
} from './delivery-publication-reconciliation.js';
import {
  validatePublicationReceipt,
  type GitHubDraftReceipt,
} from './delivery-publication-receipt.js';

type RepositoryIdentity = { path: string; gitDir: string };
type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;

export type CompleteRemotePrInventory =
  | { complete: true; candidates: readonly RemoteDraftCandidate[] }
  | { complete: false; reason: string };

export type DraftPublicationResult =
  | { status: 'published'; entry: DeliveryJournalEntry }
  | { status: 'uncertain'; entry: DeliveryJournalEntry; reason: string };

export type DraftPublicationContext = {
  workspaceId: string;
  repository: RepositoryIdentity;
  workspaceGitDir: string;
  journal: DeliveryJournal;
  initialPlan: AllowedPlan;
  refreshPlan: () => Promise<DeliveryPublicationPlan>;
  /** Independent local snapshot, ownership and remote-head verification. */
  verifySnapshot: (plan: AllowedPlan) => Promise<void>;
  /** Must enumerate all open AND closed PR pages; never return a partial list as complete. */
  listRemote: (plan: AllowedPlan) => Promise<CompleteRemotePrInventory>;
  /** Trusted server-side adapter only. Must create a draft PR; no retries. */
  createDraft: (plan: AllowedPlan) => Promise<GitHubDraftReceipt>;
};

/**
 * A single fail-closed Draft PR publication boundary. Never retries ambiguous
 * remote writes. All journal transitions occur under the shared Git lease.
 * Caller must authenticate and authorize the operator before invoking.
 */
export async function createDraftPublication(
  context: DraftPublicationContext,
): Promise<DraftPublicationResult> {
  const { workspaceId, journal, initialPlan } = context;
  if (!workspaceId || !initialPlan.allowed) throw new Error('Publication identity is required.');
  const operationKey = publicationKey(initialPlan);
  return withPublicationLease(
    context.repository,
    context.workspaceGitDir,
    { status: 'requires-lease', operationKey },
    context.refreshPlan,
    async (plan) => {
      await context.verifySnapshot(plan);
      const existing = journal.get(workspaceId);
      if (existing) {
        if (existing.operationKey !== operationKey) {
          throw new Error('Workspace already belongs to another publication operation.');
        }
        if (existing.state === 'published') {
          return { status: 'published', entry: existing } as const;
        }
        // Even a reserved record may represent a successful remote write after a crash.
        if (existing.state === 'reserved') journal.recoverWorkspace(workspaceId, operationKey);
        return reconcileOnly(context, plan, operationKey);
      }

      // Preflight catches known duplicates. A failed or incomplete inventory
      // blocks creation; it must not be interpreted as an empty result.
      const inventory = await context.listRemote(plan);
      if (!inventory.complete) {
        throw new Error('Remote PR inventory is incomplete; publication blocked.');
      }
      const preflight = reconcilePublicationCandidates(plan, inventory.candidates);
      if (preflight.status === 'confirmed') {
        // No durable local reservation exists. Do not adopt an unowned remote PR.
        throw new Error('Matching remote PR exists without local journal ownership.');
      }
      if (
        inventory.candidates.some(
          (candidate) =>
            candidate.head.ref === plan.branch && candidate.base.ref === plan.baseBranch,
        )
      ) {
        throw new Error('Remote PR identity conflict requires manual reconciliation.');
      }

      journal.reserve(workspaceId, operationKey);
      let receipt: GitHubDraftReceipt;
      try {
        receipt = await context.createDraft(plan);
      } catch {
        journal.markUncertain(workspaceId, operationKey);
        return {
          status: 'uncertain',
          entry: journal.get(workspaceId)!,
          reason: 'Remote creation outcome is unknown; reconcile before any retry.',
        } as const;
      }
      try {
        const url = validatePublicationReceipt(plan, receipt);
        return {
          status: 'published',
          entry: journal.publish(workspaceId, operationKey, url),
        } as const;
      } catch {
        journal.markUncertain(workspaceId, operationKey);
        return {
          status: 'uncertain',
          entry: journal.get(workspaceId)!,
          reason: 'Remote receipt failed verification; manual reconciliation required.',
        } as const;
      }
    },
  );
}

async function reconcileOnly(
  context: DraftPublicationContext,
  plan: AllowedPlan,
  operationKey: string,
): Promise<DraftPublicationResult> {
  let inventory: CompleteRemotePrInventory;
  try {
    inventory = await context.listRemote(plan);
  } catch {
    return {
      status: 'uncertain',
      entry: context.journal.get(context.workspaceId)!,
      reason: 'Remote inventory request failed; no write was retried.',
    };
  }
  if (!inventory.complete) {
    return {
      status: 'uncertain',
      entry: context.journal.get(context.workspaceId)!,
      reason: 'Remote PR inventory is incomplete; no write was retried.',
    };
  }
  const result = reconcilePublicationCandidates(plan, inventory.candidates);
  if (result.status !== 'confirmed') {
    return {
      status: 'uncertain',
      entry: context.journal.get(context.workspaceId)!,
      reason: result.reason,
    };
  }
  return {
    status: 'published',
    entry: context.journal.confirmUncertain(
      context.workspaceId,
      operationKey,
      result.pullRequestUrl,
    ),
  };
}
