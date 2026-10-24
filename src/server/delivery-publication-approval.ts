import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApprovedCommitSnapshot } from './delivery-github-ref-attestation.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

/**
 * Identity must come from a trusted, authenticated server session. Supplying
 * these strings in a browser request is NOT proof of operator authorization.
 */
export type TrustedDeliveryOperator = {
  operatorId: string;
  sessionId: string;
};

export type PublicationApprovalBinding = {
  workspaceId: string;
  operator: TrustedDeliveryOperator;
  plan: DeliveryPublicationPlan;
  commits: ApprovedCommitSnapshot;
};

const MAX_LIFETIME_MS = 15 * 60_000;
const DEFAULT_LIFETIME_MS = 5 * 60_000;

function validIdentity(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.:@-]+$/.test(value)
  );
}

function validSha(value: string): boolean {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function validateBinding(binding: PublicationApprovalBinding): string {
  if (!binding.plan.allowed) throw new Error('Cannot approve a blocked publication.');
  if (
    !validIdentity(binding.workspaceId) ||
    !validIdentity(binding.operator?.operatorId) ||
    !validIdentity(binding.operator?.sessionId)
  ) {
    throw new Error('Trusted workspace and operator identity are required.');
  }
  const key = publicationKey(binding.plan);
  if (
    binding.commits?.operationKey !== key ||
    !validSha(binding.commits.headCommitSha) ||
    !validSha(binding.commits.baseCommitSha) ||
    binding.commits.headCommitSha.length !== binding.commits.baseCommitSha.length
  ) {
    throw new Error('Approved commits must match the exact publication plan.');
  }
  return key;
}

/**
 * Persistent one-use operator authorization. This is a binding store, not an
 * authentication system or a replacement for independent local Git review.
 * All writes are conditional SQL statements and survive process restarts.
 */
export class DeliveryPublicationApprovalLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_publication_approvals (
      approval_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      head_commit_sha TEXT NOT NULL,
      base_commit_sha TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      revoked_at INTEGER,
      CHECK (expires_at > issued_at)
    )`);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_delivery_approvals_workspace ON delivery_publication_approvals (workspace_id, operation_key)',
    );
    // Persist a monotonic wall-clock watermark. A backwards clock jump must
    // never make an expired approval valid again, including after restart.
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_publication_approval_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at INTEGER NOT NULL
    )`);
  }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid approval clock.');
    const updated = this.db
      .prepare(
        `INSERT INTO delivery_publication_approval_clock (id, last_seen_at)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at
         WHERE delivery_publication_approval_clock.last_seen_at <= excluded.last_seen_at`,
      )
      .run(now);
    if (updated.changes !== 1) throw new Error('Publication approval clock moved backwards.');
    return now;
  }

  /**
   * Issue only after trusted operator confirmation and independent local
   * worktree/commit verification. Never issue directly from untrusted JSON.
   */
  issue(binding: PublicationApprovalBinding, lifetimeMs = DEFAULT_LIFETIME_MS): string {
    const key = validateBinding(binding);
    const issuedAt = this.timestamp();
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs <= 0 ||
      lifetimeMs > MAX_LIFETIME_MS ||
      !Number.isSafeInteger(issuedAt + lifetimeMs)
    ) {
      throw new Error('Invalid publication approval lifetime.');
    }
    const approvalId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO delivery_publication_approvals (
          approval_id, workspace_id, operator_id, session_id, operation_key,
          head_commit_sha, base_commit_sha, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approvalId,
        binding.workspaceId,
        binding.operator.operatorId,
        binding.operator.sessionId,
        key,
        binding.commits.headCommitSha,
        binding.commits.baseCommitSha,
        issuedAt,
        issuedAt + lifetimeMs,
      );
    return approvalId;
  }

  private matchingApproval(approvalId: string, binding: PublicationApprovalBinding) {
    const key = validateBinding(binding);
    if (typeof approvalId !== 'string' || !/^[0-9a-f-]{36}$/.test(approvalId)) {
      throw new Error('Invalid publication approval identifier.');
    }
    return {
      args: [
        approvalId,
        binding.workspaceId,
        binding.operator.operatorId,
        binding.operator.sessionId,
        key,
        binding.commits.headCommitSha,
        binding.commits.baseCommitSha,
        this.timestamp(),
      ] as const,
      condition: `approval_id=? AND workspace_id=? AND operator_id=? AND session_id=?
        AND operation_key=? AND head_commit_sha=? AND base_commit_sha=?
        AND issued_at<=? AND expires_at>?
        AND consumed_at IS NULL AND revoked_at IS NULL`,
    };
  }

  /**
   * Cheap preflight to prevent unauthorized requests from reaching GitHub GET.
   * This is NOT the authorization point; consume() rechecks atomically.
   */
  assertPending(approvalId: string, binding: PublicationApprovalBinding): void {
    const { args, condition } = this.matchingApproval(approvalId, binding);
    const row = this.db
      .prepare(`SELECT approval_id FROM delivery_publication_approvals WHERE ${condition}`)
      .get(...args, args[7]);
    if (!row) throw new Error('Publication approval is missing, expired or no longer valid.');
  }

  /**
   * Consume under the shared repository lease, after refreshed review and
   * remote ref attestation, immediately before the durable POST reservation.
   * A failed consume never authorizes a GitHub write.
   */
  consume(approvalId: string, binding: PublicationApprovalBinding): void {
    const { args, condition } = this.matchingApproval(approvalId, binding);
    const result = this.db
      .prepare(
        `UPDATE delivery_publication_approvals SET consumed_at=?
         WHERE ${condition}`,
      )
      .run(args[7], ...args, args[7]);
    if (result.changes !== 1) {
      throw new Error('Publication approval is missing, expired or already consumed.');
    }
  }

  /**
   * Revocation is scoped to the issuing operator and session. Revoked and
   * consumed approvals are never restored or silently replaced.
   */
  revoke(approvalId: string, operator: TrustedDeliveryOperator): boolean {
    if (!validIdentity(operator?.operatorId) || !validIdentity(operator?.sessionId)) {
      throw new Error('Trusted operator identity is required.');
    }
    return (
      this.db
        .prepare(
          `UPDATE delivery_publication_approvals SET revoked_at=?
           WHERE approval_id=? AND operator_id=? AND session_id=?
           AND consumed_at IS NULL AND revoked_at IS NULL`,
        )
        .run(this.timestamp(), approvalId, operator.operatorId, operator.sessionId).changes === 1
    );
  }
}
