import type { DatabaseSync } from 'node:sqlite';
import { withDeliveryRepositoryLease } from './delivery-publication-lease.js';

export type DeliveryGitStage = 'commit' | 'push';
export type DeliveryGitTransferState = 'intent' | 'uncertain' | 'confirmed';

export type DeliveryGitTransferIdentity = {
  workspaceId: string;
  operationKey: string;
  destination: string;
  branch: string;
  headSha: string;
  baseSha: string;
};

export type DeliveryGitTransferEntry = DeliveryGitTransferIdentity & {
  stage: DeliveryGitStage;
  state: DeliveryGitTransferState;
  receiptSha: string | null;
};

type RepositoryIdentity = { path: string; gitDir: string };

function validIdentity(input: DeliveryGitTransferIdentity): boolean {
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  return (
    typeof input.workspaceId === 'string' &&
    input.workspaceId.length > 0 &&
    input.workspaceId.length <= 200 &&
    typeof input.operationKey === 'string' &&
    input.operationKey.length > 0 &&
    input.operationKey.length <= 300 &&
    /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(input.destination) &&
    /^ai-office\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.branch,
    ) &&
    sha.test(input.headSha) &&
    sha.test(input.baseSha) &&
    input.headSha.length === input.baseSha.length
  );
}

function sameIdentity(
  entry: DeliveryGitTransferEntry,
  identity: DeliveryGitTransferIdentity,
): boolean {
  return (
    entry.workspaceId === identity.workspaceId &&
    entry.operationKey === identity.operationKey &&
    entry.destination === identity.destination &&
    entry.branch === identity.branch &&
    entry.headSha === identity.headSha &&
    entry.baseSha === identity.baseSha
  );
}

/**
 * Durable server-only receipts. No Git command or GitHub write is performed.
 * The caller must acquire the shared repository lease for all transitions.
 * An intent is never an authorization to retry a commit or push.
 */
export class DeliveryGitTransferJournal {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_git_transfers (
      workspace_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('commit', 'push')),
      operation_key TEXT NOT NULL,
      destination TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('intent', 'uncertain', 'confirmed')),
      receipt_sha TEXT,
      PRIMARY KEY (workspace_id, stage)
    )`);
  }

  get(workspaceId: string, stage: DeliveryGitStage): DeliveryGitTransferEntry | null {
    const row = this.db
      .prepare('SELECT * FROM delivery_git_transfers WHERE workspace_id=? AND stage=?')
      .get(workspaceId, stage);
    if (!row) return null;
    return {
      workspaceId: String(row.workspace_id),
      stage: String(row.stage) as DeliveryGitStage,
      operationKey: String(row.operation_key),
      destination: String(row.destination),
      branch: String(row.branch),
      headSha: String(row.head_sha),
      baseSha: String(row.base_sha),
      state: String(row.state) as DeliveryGitTransferState,
      receiptSha: row.receipt_sha === null ? null : String(row.receipt_sha),
    };
  }

  /** Read-only inventory of stages requiring recovery or manual reconciliation. */
  listUnresolved(): DeliveryGitTransferEntry[] {
    const rows = this.db
      .prepare(
        "SELECT workspace_id, stage FROM delivery_git_transfers WHERE state != 'confirmed' ORDER BY workspace_id, stage",
      )
      .all();
    return rows.map((row) =>
      this.get(String(row.workspace_id), String(row.stage) as DeliveryGitStage)!,
    );
  }

  /**
   * One reservation per workspace/stage, including after restart.
   * A push intent requires an independently confirmed matching commit receipt.
   */
  begin(stage: DeliveryGitStage, identity: DeliveryGitTransferIdentity): DeliveryGitTransferEntry {
    if (!validIdentity(identity) || (stage !== 'commit' && stage !== 'push')) {
      throw new Error('Invalid Git transfer identity.');
    }
    if (stage === 'push') this.assertConfirmed('commit', identity);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO delivery_git_transfers
         (workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', NULL)`,
      )
      .run(
        identity.workspaceId,
        stage,
        identity.operationKey,
        identity.destination,
        identity.branch,
        identity.headSha,
        identity.baseSha,
      );
    if (result.changes !== 1) {
      throw new Error('Git transfer intent already exists; reconcile before any retry.');
    }
    return this.get(identity.workspaceId, stage)!;
  }

  /** An interrupted intent remains blocked until fresh read-only evidence exists. */
  recoverWorkspace(stage: DeliveryGitStage, identity: DeliveryGitTransferIdentity) {
    const entry = this.requireMatching(stage, identity);
    if (entry.state === 'intent') {
      this.db
        .prepare(
          "UPDATE delivery_git_transfers SET state='uncertain' WHERE workspace_id=? AND stage=? AND operation_key=? AND state='intent'",
        )
        .run(identity.workspaceId, stage, identity.operationKey);
    }
    return this.get(identity.workspaceId, stage)!;
  }

  markUncertain(stage: DeliveryGitStage, identity: DeliveryGitTransferIdentity) {
    return this.recoverWorkspace(stage, identity);
  }

  /**
   * Persist a receipt ONLY after independently checking the exact local
   * commit or remote branch ref. The caller owns that verification.
   */
  confirmVerified(
    stage: DeliveryGitStage,
    identity: DeliveryGitTransferIdentity,
    verifiedSha: string,
  ): DeliveryGitTransferEntry {
    const entry = this.requireMatching(stage, identity);
    if (verifiedSha !== identity.headSha) {
      throw new Error('Verified Git transfer SHA does not match the reviewed head.');
    }
    if (stage === 'push') this.assertConfirmed('commit', identity);
    if (entry.state === 'confirmed') {
      if (entry.receiptSha === verifiedSha) return entry;
      throw new Error('Conflicting Git transfer receipt.');
    }
    const updated = this.db
      .prepare(
        `UPDATE delivery_git_transfers SET state='confirmed', receipt_sha=?
         WHERE workspace_id=? AND stage=? AND operation_key=?
         AND state IN ('intent', 'uncertain') AND receipt_sha IS NULL`,
      )
      .run(verifiedSha, identity.workspaceId, stage, identity.operationKey);
    if (updated.changes !== 1) {
      throw new Error('Git transfer state changed during verification.');
    }
    return this.get(identity.workspaceId, stage)!;
  }

  assertConfirmed(stage: DeliveryGitStage, identity: DeliveryGitTransferIdentity) {
    const entry = this.requireMatching(stage, identity);
    if (entry.state !== 'confirmed' || entry.receiptSha !== identity.headSha) {
      throw new Error('Exact Git transfer receipt is not confirmed.');
    }
    return entry;
  }

  /** Check ownership of a pending or confirmed stage without changing it. */
  assertOwned(stage: DeliveryGitStage, identity: DeliveryGitTransferIdentity) {
    return this.requireMatching(stage, identity);
  }

  /** Both independent receipts are required before a Draft PR is eligible. */
  assertReadyForDraft(identity: DeliveryGitTransferIdentity) {
    this.assertConfirmed('commit', identity);
    this.assertConfirmed('push', identity);
  }

  private requireMatching(stage: DeliveryGitStage, identity: DeliveryGitTransferIdentity) {
    if (!validIdentity(identity)) throw new Error('Invalid Git transfer identity.');
    const entry = this.get(identity.workspaceId, stage);
    if (!entry || !sameIdentity(entry, identity)) {
      throw new Error('Git transfer receipt is missing or belongs to another operation.');
    }
    return entry;
  }
}

/**
 * Read-only verification and receipt persistence under the SAME Git lease.
 * The callback must independently inspect the local commit or exact remote
 * ref; a timeout, 429, malformed result or mismatch leaves the state blocked.
 */
export async function verifyDeliveryGitTransfer(
  context: {
    journal: DeliveryGitTransferJournal;
    stage: DeliveryGitStage;
    identity: DeliveryGitTransferIdentity;
    repository: RepositoryIdentity;
    workspaceGitDir: string;
  },
  verifyReadOnly: () => Promise<string>,
): Promise<DeliveryGitTransferEntry> {
  return withDeliveryRepositoryLease(context.repository, context.workspaceGitDir, async () => {
    const entry = context.journal.get(context.identity.workspaceId, context.stage);
    if (!entry) throw new Error('Git transfer has no durable intent.');
    const verifiedSha = await verifyReadOnly();
    return context.journal.confirmVerified(context.stage, context.identity, verifiedSha);
  });
}
