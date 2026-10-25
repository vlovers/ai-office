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
import { reconcilePublicationCandidates } from './delivery-publication-reconciliation.js';
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
      // The hook is trusted server code; never accept it from an HTTP payload.
      const preflight: unknown = context.write.authorizeBeforePost?.();
      if (preflight && typeof (preflight as { then?: unknown }).then === 'function') {
        void Promise.resolve(preflight).catch(() => undefined);
        throw new Error('Draft PR authorization must be synchronous.');
      }
      authorize();
      transfers.assertReadyForDraft(identity);
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
    timeoutMs: write.timeoutMs,
  };
  const identity = {
    workspaceId,
    operationKey: commits.operationKey,
    destination: plan.destination,
    branch: plan.branch,
    headSha: commits.headCommitSha,
    baseSha: commits.baseCommitSha,
  };
  // The trusted registry may change while an asynchronous GitHub GET is in
  // flight. Compare the entire reviewed workspace, not just the operation key,
  // after each remote attestation and before a reserved Draft PR POST.
  const refreshReviewedWorkspace = async (): Promise<DeliverySecurityWorkspace> => {
    const refreshed = deliveryWorkspaceSchema.parse(await context.refreshWorkspace());
    if (JSON.stringify(refreshed) !== JSON.stringify(workspace)) {
      throw new Error('Trusted delivery workspace changed since operator review.');
    }
    return refreshed;
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
    refreshPlan: async () => (await refreshReviewedWorkspace()).plan,
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
    // Re-attest the local snapshot after the asynchronous PR inventory but
    // before consuming the operator's one-use approval in SQLite.
    verifyBeforeReserve: async (currentPlan) => {
      authorize();
      transfers.assertReadyForDraft(identity);
      await attestLocalReviewedGitState(currentPlan, {
        repository: workspace.repository,
        worktree: workspace.worktree,
        workspaceGitDir: workspace.worktree.gitDir,
        commits,
      });
      await refreshReviewedWorkspace();
      authorize();
      // The registry refresh itself yields to other local Git processes.
      await attestLocalReviewedGitState(currentPlan, {
        repository: workspace.repository,
        worktree: workspace.worktree,
        workspaceGitDir: workspace.worktree.gitDir,
        commits,
      });
      authorize();
      transfers.assertReadyForDraft(identity);
    },
    listRemote: async (currentPlan) => {
      authorize();
      return listAllGitHubPullRequests(currentPlan, refOptions);
    },
    createDraft: async (currentPlan) => {
      // Repeat authorization and remote SHA attestation immediately before the
      // single POST. A failure after reservation remains uncertain, never replayed.
      authorize();
      transfers.assertReadyForDraft(identity);
      await attestLocalReviewedGitState(currentPlan, {
        repository: workspace.repository,
        worktree: workspace.worktree,
        workspaceGitDir: workspace.worktree.gitDir,
        commits,
      });
      authorize();
      const attestation = await attestGitHubCommitRefs(currentPlan, commits, refOptions);
      authorize();
      // Remote GETs yield the event loop: a trusted registry replacement after
      // initial lease validation must fail closed before the only remote POST.
      await refreshReviewedWorkspace();
      authorize();
      // Both the GitHub GETs and registry refresh yield the event loop. A
      // non-cooperating Git process can change local refs or dirty the index
      // after the first pre-POST attestation. Recheck the exact worktree just
      // before entering the single-attempt remote write adapter.
      await attestLocalReviewedGitState(currentPlan, {
        repository: workspace.repository,
        worktree: workspace.worktree,
        workspaceGitDir: workspace.worktree.gitDir,
        commits,
      });
      authorize();
      transfers.assertReadyForDraft(identity);
      return createCommitAttestedGitHubDraft(currentPlan, attestation, write);
    },
    verifyRemoteReceipt: async (currentPlan, url) => {
      authorize();
      const detail = await readGitHubDraftCommitReceipt(currentPlan, url, refOptions);
      // A successful POST is not proof that this managed head belongs to a
      // unique PR. Another actor can publish between our preflight inventory
      // and the write. Require a second complete open/closed inventory before
      // persisting a receipt, even on the successful (non-recovery) path.
      // Missing/ambiguous results are uncertain, never permission to POST again.
      const inventory = await listAllGitHubPullRequests(currentPlan, refOptions);
      const ownership = reconcilePublicationCandidates(currentPlan, inventory.candidates);
      if (ownership.status !== 'confirmed' || ownership.pullRequestUrl !== url) {
        throw new Error('Draft PR managed-head ownership is not uniquely verified.');
      }
      // A registry replacement during a slow PR detail GET or inventory cannot turn a
      // stale or revoked review into a durable confirmed publication receipt.
      await refreshReviewedWorkspace();
      authorize();
      // A completed POST or a recovered remote PR is not enough to persist a
      // local success receipt if Git changed while the detail GET was pending.
      // Keep the durable journal uncertain until the reviewed local identity
      // is still valid at the final confirmation boundary.
      await attestLocalReviewedGitState(currentPlan, {
        repository: workspace.repository,
        worktree: workspace.worktree,
        workspaceGitDir: workspace.worktree.gitDir,
        commits,
      });
      authorize();
      transfers.assertReadyForDraft(identity);
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
