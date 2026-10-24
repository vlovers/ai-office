import type { DeliveryJournal, DeliveryJournalEntry } from './delivery-journal.js';
import { publicationReadiness } from './delivery-publication-coordinator.js';
import { executeReservedPublication } from './delivery-publication-execution.js';
import { decidePublication } from './delivery-publication-idempotency.js';
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

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;

export type DeliveryPublicationContext = {
  journal: DeliveryJournal;
  workspaceId: string;
  repository: { path: string; gitDir: string };
  workspaceGitDir: string;
  /** Reviewed plan from the explicit operator confirmation. */
  plan: DeliveryPublicationPlan;
  /** Re-read task, workspace, review and destination while holding the lease. */
  refreshPlan: () => Promise<DeliveryPublicationPlan>;
};

function requireNewPublication(plan: DeliveryPublicationPlan) {
  const readiness = publicationReadiness(plan, null);
  if (readiness.status !== 'requires-lease') {
    throw new Error(
      readiness.status === 'blocked' ? readiness.reason : 'Publication already exists.',
    );
  }
  return readiness;
}

/**
 * Exactly one remote CREATE attempt per workspace, even after timeouts.
 * createDraft is an injected, authenticated adapter; this service never
 * shells out or enables a production GitHub integration by itself.
 */
export async function publishApprovedDraft(
  context: DeliveryPublicationContext & {
    createDraft: (plan: AllowedPlan) => Promise<GitHubDraftReceipt>;
  },
): Promise<DeliveryJournalEntry> {
  const readiness = requireNewPublication(context.plan);
  return withPublicationLease(
    context.repository,
    context.workspaceGitDir,
    readiness,
    context.refreshPlan,
    async (currentPlan) => {
      const existing = context.journal.get(context.workspaceId);
      if (existing) {
        if (existing.operationKey !== readiness.operationKey) {
          throw new Error('Workspace already has a different publication operation.');
        }
        if (existing.state !== 'published') {
          throw new Error('Publication outcome is uncertain; reconcile before retrying.');
        }
        const decision = decidePublication(currentPlan, {
          revision: currentPlan.revision,
          branch: currentPlan.branch,
          destination: currentPlan.destination,
          baseBranch: currentPlan.baseBranch,
          draft: true,
          pullRequestUrl: existing.pullRequestUrl ?? '',
        });
        if (decision.action !== 'reuse') {
          throw new Error('Stored publication receipt failed validation.');
        }
        return existing;
      }
      return executeReservedPublication(
        context.journal,
        context.workspaceId,
        readiness,
        async () =>
          validatePublicationReceipt(currentPlan, await context.createDraft(currentPlan)),
      );
    },
  );
}

/**
 * Only a complete, independently fetched GitHub PR listing may resolve an
 * uncertain write. Empty or partial results never authorize a new POST.
 * Startup must call journal.recoverInterrupted() once, before accepting work.
 */
export async function reconcileUncertainDraft(
  context: DeliveryPublicationContext & {
    listAllRemoteDrafts: (
      plan: AllowedPlan,
    ) => Promise<{ complete: boolean; candidates: RemoteDraftCandidate[] }>;
  },
): Promise<DeliveryJournalEntry> {
  const readiness = requireNewPublication(context.plan);
  return withPublicationLease(
    context.repository,
    context.workspaceGitDir,
    readiness,
    context.refreshPlan,
    async (currentPlan) => {
      const entry = context.journal.get(context.workspaceId);
      if (entry?.operationKey !== readiness.operationKey || entry.state !== 'uncertain') {
        throw new Error('Only the matching uncertain operation can be reconciled.');
      }
      const snapshot = await context.listAllRemoteDrafts(currentPlan);
      if (snapshot?.complete !== true || !Array.isArray(snapshot.candidates)) {
        throw new Error('GitHub PR listing is incomplete; manual recovery required.');
      }
      const result = reconcilePublicationCandidates(currentPlan, snapshot.candidates);
      if (result.status !== 'confirmed') throw new Error(result.reason);
      return context.journal.confirmUncertain(
        context.workspaceId,
        readiness.operationKey,
        result.pullRequestUrl,
      );
    },
  );
}
