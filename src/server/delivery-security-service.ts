import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { reserveApprovedTransferIntentAtomically } from './delivery-approved-transfer-reservation.js';
import { DeliveryGitTransferJournal } from './delivery-git-transfer-journal.js';
import { attestGitHubCommitRefs } from './delivery-github-ref-attestation.js';
import type { DeliveryGitHubCredentials } from './delivery-github-credentials.js';
import { attestLocalReviewedGitState } from './delivery-local-git-attestation.js';
import { DeliveryPublicationApprovalLedger } from './delivery-publication-approval.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import { withDeliveryRepositoryLease } from './delivery-publication-lease.js';
import { DeliveryTransferApprovalLedger } from './delivery-transfer-approval.js';
import {
  deliveryIdentifierSchema,
  DeliverySecurityError,
  type DeliveryOperation,
  type DeliverySessions,
} from './delivery-sessions.js';

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const repository = z
  .object({ path: z.string().refine(isAbsolute), gitDir: z.string().refine(isAbsolute) })
  .strict();
export const deliveryWorkspaceSchema = z
  .object({
    workspaceId: deliveryIdentifierSchema,
    repository,
    worktree: repository,
    plan: z
      .object({
        allowed: z.literal(true),
        destination: z
          .string()
          .regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)
          .refine((value) => !/\/(?:\.|\.\.)$/.test(value)),
        branch: z
          .string()
          .regex(/^ai-office\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        baseBranch: z.literal('main'),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        draft: z.literal(true),
      })
      .strict(),
    headSha: sha,
    baseSha: sha,
  })
  .strict()
  .refine((value) => value.headSha.length === value.baseSha.length);
export type DeliverySecurityWorkspace = z.infer<typeof deliveryWorkspaceSchema>;
export const approvalOperationSchema = z.enum(['commit', 'push', 'draft-pr']);
type ApprovalOperation = z.infer<typeof approvalOperationSchema>;

/**
 * Narrow production facade over existing journals. The immutable registry is
 * supplied by trusted server configuration, never browser data. It exposes no
 * callback, path, token, arbitrary Git command, or external write capability.
 */
export class DeliverySecurityService {
  private readonly registry = new Map<string, DeliverySecurityWorkspace>();
  private readonly transfers: DeliveryTransferApprovalLedger;
  private readonly publications: DeliveryPublicationApprovalLedger;
  readonly journal: DeliveryGitTransferJournal;

  constructor(
    readonly sessions: DeliverySessions,
    workspaces: readonly DeliverySecurityWorkspace[],
    private readonly credentials?: DeliveryGitHubCredentials,
  ) {
    for (const value of z.array(deliveryWorkspaceSchema).max(1000).parse(workspaces)) {
      if (this.registry.has(value.workspaceId)) throw new DeliverySecurityError(503);
      this.registry.set(value.workspaceId, value);
    }
    this.transfers = new DeliveryTransferApprovalLedger(sessions.db, sessions.now);
    this.publications = new DeliveryPublicationApprovalLedger(sessions.db, sessions.now);
    this.journal = new DeliveryGitTransferJournal(sessions.db);
  }

  private identity(workspace: DeliverySecurityWorkspace) {
    return {
      workspaceId: workspace.workspaceId,
      operationKey: publicationKey(workspace.plan),
      destination: workspace.plan.destination,
      branch: workspace.plan.branch,
      headSha: workspace.headSha,
      baseSha: workspace.baseSha,
    };
  }

  private snapshot(workspace: DeliverySecurityWorkspace) {
    const identity = this.identity(workspace);
    const reviewId = createHash('sha256')
      .update(
        JSON.stringify([
          identity,
          workspace.plan.revision,
          workspace.repository,
          workspace.worktree,
        ]),
      )
      .digest('hex');
    return {
      ...identity,
      reviewId,
      baseBranch: workspace.plan.baseBranch,
      revision: workspace.plan.revision,
      remoteWritesEnabled: false,
    };
  }

  private async reviewed<T>(
    token: string,
    workspaceId: string,
    operation: DeliveryOperation,
    action: (workspace: DeliverySecurityWorkspace) => Promise<T> | T,
  ): Promise<T> {
    this.sessions.authorize(token, workspaceId, operation);
    const workspace = this.registry.get(workspaceId);
    if (!workspace) throw new DeliverySecurityError(403);
    try {
      return await withDeliveryRepositoryLease(
        workspace.repository,
        workspace.worktree.gitDir,
        async () => {
          this.sessions.authorize(token, workspaceId, operation);
          await attestLocalReviewedGitState(workspace.plan, {
            repository: workspace.repository,
            worktree: workspace.worktree,
            workspaceGitDir: workspace.worktree.gitDir,
            commits: {
              operationKey: publicationKey(workspace.plan),
              headCommitSha: workspace.headSha,
              baseCommitSha: workspace.baseSha,
            },
          });
          this.sessions.authorize(token, workspaceId, operation);
          return action(workspace);
        },
      );
    } catch (error) {
      if (error instanceof DeliverySecurityError) throw error;
      // Git errors can include credential-bearing origin URLs or local paths.
      throw new DeliverySecurityError(409);
    }
  }

  review(token: string, workspaceId: string) {
    return this.reviewed(token, workspaceId, 'review', (workspace) => this.snapshot(workspace));
  }

  approve(token: string, workspaceId: string, operation: ApprovalOperation, reviewId: string) {
    approvalOperationSchema.parse(operation);
    return this.reviewed(token, workspaceId, `approve:${operation}`, (workspace) => {
      if (reviewId !== this.snapshot(workspace).reviewId) throw new DeliverySecurityError(409);
      const approvalId = this.sessions.withAuthorization(
        token,
        workspaceId,
        `approve:${operation}`,
        (operator) => {
          if (operation === 'draft-pr') {
            // Eligibility is stronger than a session grant: both receipts must exist.
            this.journal.assertReadyForDraft(this.identity(workspace));
            return this.publications.issue({
              workspaceId,
              operator,
              plan: workspace.plan,
              commits: {
                operationKey: publicationKey(workspace.plan),
                headCommitSha: workspace.headSha,
                baseCommitSha: workspace.baseSha,
              },
            });
          }
          if (operation === 'push')
            this.journal.assertConfirmed('commit', this.identity(workspace));
          return this.transfers.issue({
            stage: operation,
            identity: this.identity(workspace),
            operator,
          });
        },
      );
      return { approvalId, operation, reviewId, remoteWritesEnabled: false };
    });
  }

  /** Reservation ONLY; the intent is never returned as authority to run Git later. */
  reserve(
    token: string,
    workspaceId: string,
    stage: 'commit' | 'push',
    reviewId: string,
    approvalId: string,
  ) {
    z.enum(['commit', 'push']).parse(stage);
    return this.reviewed(token, workspaceId, `reserve:${stage}`, (workspace) => {
      if (reviewId !== this.snapshot(workspace).reviewId) throw new DeliverySecurityError(409);
      // Issuance permission must still exist when an approval is used.
      const operator = this.sessions.authorize(token, workspaceId, `approve:${stage}`);
      const entry = reserveApprovedTransferIntentAtomically(
        this.sessions.db,
        approvalId,
        { stage, identity: this.identity(workspace), operator },
        this.sessions.now,
        () => {
          this.sessions.authorize(token, workspaceId, `approve:${stage}`);
          this.sessions.authorize(token, workspaceId, `reserve:${stage}`);
        },
      );
      return { stage: entry.stage, state: entry.state, remoteWritesEnabled: false };
    });
  }

  revokeApproval(
    token: string,
    workspaceId: string,
    operation: ApprovalOperation,
    approvalId: string,
  ) {
    approvalOperationSchema.parse(operation);
    try {
      return this.sessions.withAuthorization(
        token,
        workspaceId,
        `approve:${operation}`,
        (operator) => {
          const table =
            operation === 'draft-pr'
              ? 'delivery_publication_approvals'
              : 'delivery_transfer_approvals';
          const row = this.sessions.db
            .prepare(
              `SELECT workspace_id, ${operation === 'draft-pr' ? 'NULL AS stage' : 'stage'} FROM ${table} WHERE approval_id=? AND operator_id=? AND session_id=?`,
            )
            .get(approvalId, operator.operatorId, operator.sessionId);
          if (
            !row ||
            row.workspace_id !== workspaceId ||
            (operation !== 'draft-pr' && row.stage !== operation)
          )
            throw new DeliverySecurityError(409);
          const ledger = operation === 'draft-pr' ? this.publications : this.transfers;
          if (!ledger.revoke(approvalId, operator)) throw new DeliverySecurityError(409);
          return { revoked: true };
        },
      );
    } catch (error) {
      if (error instanceof DeliverySecurityError) throw error;
      throw new DeliverySecurityError(409);
    }
  }

  remoteStatus(token: string, workspaceId: string) {
    return this.reviewed(token, workspaceId, 'remote:read', async (workspace) => {
      if (!this.credentials) throw new DeliverySecurityError(503);
      const fetcher = this.credentials.readOnlyFetcher(
        workspace.plan.destination.slice('https://github.com/'.length),
        [workspace.plan.branch, 'main'],
        () => {
          this.sessions.authorize(token, workspaceId, 'remote:read');
        },
      );
      const attested = await attestGitHubCommitRefs(
        workspace.plan,
        {
          operationKey: publicationKey(workspace.plan),
          headCommitSha: workspace.headSha,
          baseCommitSha: workspace.baseSha,
        },
        { fetcher },
      );
      this.sessions.authorize(token, workspaceId, 'remote:read');
      return {
        headSha: attested.headCommitSha,
        baseSha: attested.baseCommitSha,
        remoteWritesEnabled: false,
      };
    });
  }
}
