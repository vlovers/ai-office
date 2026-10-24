import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DeliveryGitStage,
  DeliveryGitTransferIdentity,
} from './delivery-git-transfer-journal.js';
import type { TrustedDeliveryOperator } from './delivery-publication-approval.js';

const MAX_LIFETIME_MS = 15 * 60_000;
const DEFAULT_LIFETIME_MS = 5 * 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,200}$/;
const MANAGED_BRANCH =
  /^ai-office\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESTINATION = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/;

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export type DeliveryTransferApprovalBinding = {
  stage: DeliveryGitStage;
  identity: DeliveryGitTransferIdentity;
  operator: TrustedDeliveryOperator;
};

function validate(binding: DeliveryTransferApprovalBinding): void {
  const { stage, identity, operator } = binding;
  if (
    (stage !== 'commit' && stage !== 'push') ||
    !identity ||
    !operator ||
    !validIdentifier(identity.workspaceId) ||
    !validIdentifier(operator.operatorId) ||
    !validIdentifier(operator.sessionId) ||
    typeof identity.operationKey !== 'string' ||
    identity.operationKey.length < 1 ||
    identity.operationKey.length > 300 ||
    typeof identity.destination !== 'string' ||
    !DESTINATION.test(identity.destination) ||
    typeof identity.branch !== 'string' ||
    !MANAGED_BRANCH.test(identity.branch) ||
    typeof identity.headSha !== 'string' ||
    !SHA.test(identity.headSha) ||
    typeof identity.baseSha !== 'string' ||
    !SHA.test(identity.baseSha) ||
    identity.headSha.length !== identity.baseSha.length
  ) {
    throw new Error('Invalid trusted Git transfer approval binding.');
  }
}

/**
 * Server-only, one-use approval ledger. Callers MUST independently authenticate
 * the operator and re-attest the reviewed Git state before issuing or consuming.
 * This class does not execute Git commands, authorize an HTTP request, or retry
 * ambiguous external writes.
 */
export class DeliveryTransferApprovalLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_transfer_approvals (
      approval_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL CHECK (stage IN ('commit', 'push')),
      workspace_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      destination TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      revoked_at INTEGER,
      CHECK (expires_at > issued_at)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_transfer_approval_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at INTEGER NOT NULL
    )`);
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Git transfer approval clock.');
    }
    const result = this.db
      .prepare(`INSERT INTO delivery_transfer_approval_clock (id, last_seen_at)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at
        WHERE delivery_transfer_approval_clock.last_seen_at <= excluded.last_seen_at`)
      .run(value);
    if (result.changes !== 1) throw new Error('Git transfer approval clock moved backwards.');
    return value;
  }

  issue(binding: DeliveryTransferApprovalBinding, lifetimeMs = DEFAULT_LIFETIME_MS): string {
    validate(binding);
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_LIFETIME_MS) {
      throw new Error('Invalid Git transfer approval lifetime.');
    }
    const issuedAt = this.timestamp();
    if (!Number.isSafeInteger(issuedAt + lifetimeMs)) {
      throw new Error('Invalid Git transfer approval expiry.');
    }
    const approvalId = randomUUID();
    const { identity, operator } = binding;
    this.db
      .prepare(`INSERT INTO delivery_transfer_approvals
        (approval_id, stage, workspace_id, operator_id, session_id, operation_key,
         destination, branch, head_sha, base_sha, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        approvalId,
        binding.stage,
        identity.workspaceId,
        operator.operatorId,
        operator.sessionId,
        identity.operationKey,
        identity.destination,
        identity.branch,
        identity.headSha,
        identity.baseSha,
        issuedAt,
        issuedAt + lifetimeMs,
      );
    return approvalId;
  }

  private match(approvalId: string, binding: DeliveryTransferApprovalBinding) {
    validate(binding);
    if (
      typeof approvalId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(approvalId)
    ) {
      throw new Error('Invalid Git transfer approval identifier.');
    }
    const { identity, operator } = binding;
    const timestamp = this.timestamp();
    return {
      args: [
        approvalId,
        binding.stage,
        identity.workspaceId,
        operator.operatorId,
        operator.sessionId,
        identity.operationKey,
        identity.destination,
        identity.branch,
        identity.headSha,
        identity.baseSha,
        timestamp,
        timestamp,
        timestamp,
      ] as const,
      condition: `approval_id=? AND stage=? AND workspace_id=? AND operator_id=?
        AND session_id=? AND operation_key=? AND destination=? AND branch=?
        AND head_sha=? AND base_sha=? AND issued_at<=? AND expires_at>?
        AND (SELECT last_seen_at FROM delivery_transfer_approval_clock WHERE id=1)=?
        AND consumed_at IS NULL AND revoked_at IS NULL`,
    };
  }

  assertPending(approvalId: string, binding: DeliveryTransferApprovalBinding): void {
    const { args, condition } = this.match(approvalId, binding);
    const row = this.db
      .prepare(`SELECT approval_id FROM delivery_transfer_approvals WHERE ${condition}`)
      .get(...args);
    if (!row) throw new Error('Git transfer approval is missing, expired or invalid.');
  }

  consume(approvalId: string, binding: DeliveryTransferApprovalBinding): void {
    const { args, condition } = this.match(approvalId, binding);
    const result = this.db
      .prepare(`UPDATE delivery_transfer_approvals SET consumed_at=?
        WHERE ${condition}`)
      .run(args[10], ...args);
    if (result.changes !== 1) {
      throw new Error('Git transfer approval is missing, expired or already consumed.');
    }
  }

  revoke(approvalId: string, operator: TrustedDeliveryOperator): boolean {
    if (
      !operator ||
      !validIdentifier(operator.operatorId) ||
      !validIdentifier(operator.sessionId)
    ) {
      throw new Error('Invalid trusted operator.');
    }
    return (
      this.db
        .prepare(`UPDATE delivery_transfer_approvals SET revoked_at=?
        WHERE approval_id=? AND operator_id=? AND session_id=?
        AND consumed_at IS NULL AND revoked_at IS NULL`)
        .run(this.timestamp(), approvalId, operator.operatorId, operator.sessionId).changes === 1
    );
  }
}
