import type { DeliveryJournalEntry, DeliveryJournal } from './delivery-journal.js';
import { decidePublication, publicationKey } from './delivery-publication-idempotency.js';
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
  /** Optional final local/registry attestation after remote inventory, before consuming approval. */
  verifyBeforeReserve?: (plan: AllowedPlan) => Promise<void>;
  /** Trusted server-side adapter only. Must create a draft PR; no retries. */
  createDraft: (plan: AllowedPlan) => Promise<GitHubDraftReceipt>;
  /** Optional trusted atomic approval+reservation adapter; no external writes inside. */
  reserveApproved?: (plan: AllowedPlan) => DeliveryJournalEntry;
  /** Mandatory independent PR detail verification, including immutable commit SHAs. */
  verifyRemoteReceipt: (plan: AllowedPlan, url: string) => Promise<void>;
};

/**
 * Treat the GitHub inventory adapter as a runtime trust boundary, even though
 * its TypeScript interface is typed. Malformed or truncated responses must
 * never be interpreted as an empty repository.
 */
function isValidCompleteInventory(
  inventory: CompleteRemotePrInventory,
): inventory is Extract<CompleteRemotePrInventory, { complete: true }> {
  return (
    inventory?.complete === true &&
    Array.isArray(inventory.candidates) &&
    inventory.candidates.length <= 100_000 &&
    inventory.candidates.every(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        typeof candidate.html_url === 'string' &&
        typeof candidate.draft === 'boolean' &&
        typeof candidate.state === 'string' &&
        typeof candidate.head?.ref === 'string' &&
        typeof candidate.base?.ref === 'string' &&
        (candidate.head.repo === null || typeof candidate.head.repo?.full_name === 'string') &&
        (candidate.base.repo === null || typeof candidate.base.repo?.full_name === 'string'),
    )
  );
}

/**
 * A single fail-closed Draft PR publication boundary. Never retries ambiguous
 * remote writes. All journal transitions occur under the shared Git lease.
 * Caller must authenticate and authorize the operator before invoking.
 */
export async function createDraftPublication(
  context: DraftPublicationContext,
): Promise<DraftPublicationResult> {
  const { workspaceId, journal, initialPlan } = context;
  if (!workspaceId || !initialPlan.allowed) {
    throw new Error('Publication identity is required.');
  }
  // A list entry or POST body is not an independently verified commit-pinned
  // receipt. Reject unsafe generic callers before any lease or journal write.
  if (typeof context.verifyRemoteReceipt !== 'function') {
    throw new Error('Independent GitHub PR detail verification is required.');
  }
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
          const decision = decidePublication(plan, {
            revision: plan.revision,
            branch: plan.branch,
            destination: plan.destination,
            baseBranch: plan.baseBranch,
            draft: true,
            pullRequestUrl: existing.pullRequestUrl ?? '',
          });
          if (decision.action !== 'reuse') {
            throw new Error('Stored publication receipt failed destination verification.');
          }
          await context.verifyRemoteReceipt(plan, existing.pullRequestUrl!);
          await revalidateReceiptSnapshot(context, operationKey);
          return { status: 'published', entry: existing } as const;
        }
        // Even a reserved record may represent a successful remote write after a crash.
        if (existing.state === 'reserved') {
          journal.recoverWorkspace(workspaceId, operationKey);
        }
        return reconcileOnly(context, plan, operationKey);
      }

      // Preflight catches known duplicates. A failed or incomplete inventory
      // blocks creation; it must not be interpreted as an empty result.
      let inventory: CompleteRemotePrInventory;
      try {
        inventory = await context.listRemote(plan);
      } catch {
        throw new Error('Remote PR inventory failed; publication blocked.');
      }
      if (!isValidCompleteInventory(inventory)) {
        throw new Error('Remote PR inventory is incomplete or invalid; publication blocked.');
      }
      const preflight = reconcilePublicationCandidates(plan, inventory.candidates);
      if (preflight.status === 'confirmed') {
        // No durable local reservation exists. Do not adopt an unowned remote PR.
        throw new Error('Matching remote PR exists without local journal ownership.');
      }
      const branchConflict = inventory.candidates.some(
        (candidate) => candidate.head.ref === plan.branch,
      );
      if (branchConflict) {
        throw new Error('Remote PR head branch conflict requires manual reconciliation.');
      }

      // Inventory is asynchronous. Do not consume the one-use approval if the
      // trusted review or local Git snapshot changed while listing PRs.
      const preReservePlan = await context.refreshPlan();
      if (!preReservePlan.allowed || publicationKey(preReservePlan) !== operationKey) {
        throw new Error('Publication snapshot changed during remote inventory.');
      }
      await context.verifyBeforeReserve?.(preReservePlan);

      const reservation = context.reserveApproved
        ? context.reserveApproved(plan)
        : journal.reserve(workspaceId, operationKey);
      if (
        reservation.workspaceId !== workspaceId ||
        reservation.operationKey !== operationKey ||
        reservation.state !== 'reserved' ||
        reservation.pullRequestUrl !== null ||
        journal.get(workspaceId)?.operationKey !== operationKey ||
        journal.get(workspaceId)?.state !== 'reserved' ||
        journal.get(workspaceId)?.pullRequestUrl !== null
      ) {
        throw new Error('Publication reservation did not persist the reviewed operation.');
      }
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
        await context.verifyRemoteReceipt(plan, url);
        await revalidateReceiptSnapshot(context, operationKey);
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
  if (!isValidCompleteInventory(inventory)) {
    return {
      status: 'uncertain',
      entry: context.journal.get(context.workspaceId)!,
      reason: 'Remote PR inventory is incomplete or invalid; no write was retried.',
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
  try {
    await context.verifyRemoteReceipt(plan, result.pullRequestUrl);
    await revalidateReceiptSnapshot(context, operationKey);
  } catch {
    return {
      status: 'uncertain',
      entry: context.journal.get(context.workspaceId)!,
      reason:
        'Remote PR receipt or final reviewed snapshot failed verification; no write was retried.',
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

/**
 * Remote GETs and receipt verification yield the event loop. A stale review
 * must not be committed as published after an independent verification call.
 * This is deliberately read-only and runs under the shared repository lease.
 */
async function revalidateReceiptSnapshot(
  context: DraftPublicationContext,
  operationKey: string,
): Promise<void> {
  const refreshed = await context.refreshPlan();
  if (!refreshed.allowed || publicationKey(refreshed) !== operationKey) {
    throw new Error('Publication snapshot changed before durable receipt confirmation.');
  }
  await context.verifySnapshot(refreshed);
}
