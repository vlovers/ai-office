import type { DeliveryJournal, DeliveryJournalEntry } from './delivery-journal.js';
import {
  attestGitHubCommitRefs,
  readGitHubDraftCommitReceipt,
  validateAttestedDraftReceipt,
  type ApprovedCommitSnapshot,
  type AttestedGitRefs,
  type GitHubCommitReceipt,
  type GitHubRefOptions,
} from './delivery-github-ref-attestation.js';
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
      return executeReservedPublication(context.journal, context.workspaceId, readiness, async () =>
        validatePublicationReceipt(currentPlan, await context.createDraft(currentPlan)),
      );
    },
  );
}

/**
 * Commit-pinned publication variant. The remote head and base Git refs are
 * fetched under the SAME shared lease as the durable reservation and POST.
 * The returned PR must still name those exact commits after the POST.
 *
 * This is an injected boundary, not a live endpoint. The approval snapshot
 * must come from independently verified local Git state and operator review.
 */
export async function publishCommitAttestedDraft(
  context: DeliveryPublicationContext & {
    approval: ApprovedCommitSnapshot;
    gitHubRefOptions?: GitHubRefOptions;
    createDraft: (plan: AllowedPlan, attestation: AttestedGitRefs) => Promise<GitHubCommitReceipt>;
    /** Optional for legacy server-only callers; authenticated entrypoints must provide it. */
    authorizeBeforeReserve?: (plan: AllowedPlan) => Promise<void> | void;
  },
): Promise<DeliveryJournalEntry> {
  const readiness = requireNewPublication(context.plan);
  if (context.approval.operationKey !== readiness.operationKey) {
    throw new Error('Approved commit snapshot does not match the publication operation.');
  }
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
      const attestation = await attestGitHubCommitRefs(
        currentPlan,
        context.approval,
        context.gitHubRefOptions,
      );
      // After remote SHA attestation but before the durable reservation and
      // any POST. Authorization is consumed exactly once under the Git lease.
      await context.authorizeBeforeReserve?.(currentPlan);
      return executeReservedPublication(context.journal, context.workspaceId, readiness, async () =>
        validateAttestedDraftReceipt(
          currentPlan,
          attestation,
          await context.createDraft(currentPlan, attestation),
        ),
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

/**
 * Recover an ambiguous commit-pinned publication without a second POST.
 * A complete PR listing identifies the unique candidate; a separate fresh
 * PR detail GET verifies both commit SHAs before changing durable state.
 * Missing, stale or malformed evidence leaves the journal uncertain.
 */
export async function reconcileCommitAttestedDraft(
  context: DeliveryPublicationContext & {
    approval: ApprovedCommitSnapshot;
    gitHubRefOptions?: GitHubRefOptions;
    listAllRemoteDrafts: (
      plan: AllowedPlan,
    ) => Promise<{ complete: boolean; candidates: RemoteDraftCandidate[] }>;
  },
): Promise<DeliveryJournalEntry> {
  const readiness = requireNewPublication(context.plan);
  if (context.approval.operationKey !== readiness.operationKey) {
    throw new Error('Approved commit snapshot does not match the publication operation.');
  }
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
      const detail = await readGitHubDraftCommitReceipt(
        currentPlan,
        result.pullRequestUrl,
        context.gitHubRefOptions,
      );
      const attestation = {
        ...context.approval,
        repository: currentPlan.destination.slice('https://github.com/'.length),
        branch: currentPlan.branch,
        baseBranch: currentPlan.baseBranch,
      };
      const verifiedUrl = validateAttestedDraftReceipt(currentPlan, attestation, detail);
      if (verifiedUrl !== result.pullRequestUrl) {
        throw new Error('GitHub PR identity changed during read-only reconciliation.');
      }
      return context.journal.confirmUncertain(
        context.workspaceId,
        readiness.operationKey,
        verifiedUrl,
      );
    },
  );
}
