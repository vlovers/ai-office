import { createApprovedDraftPublication } from './delivery-approved-draft-publication.js';
import {
  createCommitAttestedGitHubDraft,
  validateGitHubDraftWrite,
  type GitHubDraftWriteOptions,
} from './delivery-github-draft-write.js';
import {
  attestGitHubCommitRefs,
  readGitHubDraftCommitReceipt,
  validateAttestedDraftReceipt,
} from './delivery-github-ref-attestation.js';
import { listAllGitHubPullRequests } from './delivery-github-readonly.js';
import { DeliveryGitTransferJournal } from './delivery-git-transfer-journal.js';
import { attestLocalReviewedGitState } from './delivery-local-git-attestation.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import {
  deliveryWorkspaceSchema,
  type DeliverySecurityWorkspace,
} from './delivery-security-service.js';
import { DeliverySecurityError, type DeliverySessions } from './delivery-sessions.js';

/**
 * Server-only composition of the actual operator session, commit/push receipts,
 * local and remote Git attestation, complete GitHub inventory, one-use approval
 * and durable Draft PR publication. No HTTP route or production activation.
 *
 * The workspace and refresh callback MUST come from the trusted server registry.
 * The session token MUST come from authenticated server session state, and the
 * GitHub write credential MUST be server-owned. Never pass browser JSON here.
 */
export type SessionBoundDraftContext = {
  sessions: DeliverySessions;
  sessionToken: string;
  workspace: DeliverySecurityWorkspace;
  refreshWorkspace: () => Promise<DeliverySecurityWorkspace>;
  approvalId: string;
  write: Omit<GitHubDraftWriteOptions, 'confirmation'>;
};

export async function createSessionBoundGitHubDraft(context: SessionBoundDraftContext) {
  const workspace = deliveryWorkspaceSchema.parse(context.workspace);
  const { workspaceId, plan } = workspace;
  const operator = context.sessions.authorize(
    context.sessionToken,
    workspaceId,
    'approve:draft-pr',
  );
  const commits = {
    operationKey: publicationKey(plan),
    headCommitSha: workspace.headSha,
    baseCommitSha: workspace.baseSha,
  };
  const binding = { workspaceId, operator, plan, commits };
  const write: GitHubDraftWriteOptions = {
    ...context.write,
    confirmation: { ...commits, action: 'create-draft-pr' },
    authorizeBeforePost: () => {
      authorize();
      context.write.authorizeBeforePost?.();
    },
  };
  // Reject invalid write configuration before acquiring a lease or using GitHub.
  validateGitHubDraftWrite(plan, commits, write);
  const transfers = new DeliveryGitTransferJournal(context.sessions.db);
  const authorize = (): void => {
    const current = context.sessions.authorize(
      context.sessionToken,
      workspaceId,
      'approve:draft-pr',
    );
    if (current.operatorId !== operator.operatorId || current.sessionId !== operator.sessionId) {
      throw new DeliverySecurityError(403);
    }
  };
  const refOptions = {
    token: write.token,
    fetcher: write.fetcher,
    signal: write.signal,
  };
  const identity = {
    workspaceId,
    operationKey: commits.operationKey,
    destination: plan.destination,
    branch: plan.branch,
    headSha: commits.headCommitSha,
    baseSha: commits.baseCommitSha,
  };
  const repository = plan.destination.slice('https://github.com/'.length);
  return createApprovedDraftPublication({
    db: context.sessions.db,
    approvalId: context.approvalId,
    binding,
    workspaceId,
    repository: workspace.repository,
    workspaceGitDir: workspace.worktree.gitDir,
    initialPlan: plan,
    now: context.sessions.now,
    authorizeBeforeReserve: authorize,
    refreshPlan: async () => {
      const refreshed = deliveryWorkspaceSchema.parse(await context.refreshWorkspace());
      // Include repository/worktree ownership and reviewed SHAs, not just the
      // publicationKey: a registry swap must never authorize a stale review.
      if (JSON.stringify(refreshed) !== JSON.stringify(workspace)) {
        throw new Error('Trusted delivery workspace changed since operator review.');
      }
      return refreshed.plan;
    },
    verifyApprovedSnapshot: async (currentPlan) => {
      authorize();
      transfers.assertReadyForDraft(identity);
      await attestLocalReviewedGitState(currentPlan, {
        repository: workspace.repository,
        worktree: workspace.worktree,
        workspaceGitDir: workspace.worktree.gitDir,
        commits,
      });
      authorize();
      await attestGitHubCommitRefs(currentPlan, commits, refOptions);
      authorize();
    },
    listRemote: async (currentPlan) => {
      authorize();
      return listAllGitHubPullRequests(currentPlan, refOptions);
    },
    createDraft: async (currentPlan) => {
      // Repeat authorization and remote SHA attestation immediately before the
      // single POST. A failure after reservation remains uncertain, never replayed.
      authorize();
      const attestation = await attestGitHubCommitRefs(currentPlan, commits, refOptions);
      authorize();
      return createCommitAttestedGitHubDraft(currentPlan, attestation, write);
    },
    verifyRemoteReceipt: async (currentPlan, url) => {
      authorize();
      const detail = await readGitHubDraftCommitReceipt(currentPlan, url, refOptions);
      validateAttestedDraftReceipt(
        currentPlan,
        {
          ...commits,
          repository,
          branch: currentPlan.branch,
          baseBranch: currentPlan.baseBranch,
        },
        detail,
      );
      authorize();
    },
  });
}
