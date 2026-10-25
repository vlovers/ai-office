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
    // SQLite executes triggers inside the INSERT statement's writer lock.
    // Unlike a SELECT-then-INSERT check, this excludes competing workspaces
    // even when separate Node processes race to reserve the same branch.
    // Creating the triggers does not rewrite or discard legacy conflicting
    // rows: assertReadyForDraft still detects those during migration.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_exclusive_insert
      BEFORE INSERT ON delivery_git_transfers
      WHEN EXISTS (
        SELECT 1 FROM delivery_git_transfers
        WHERE workspace_id != NEW.workspace_id
          AND (operation_key = NEW.operation_key OR
            (destination COLLATE NOCASE = NEW.destination AND branch = NEW.branch))
      )
      BEGIN
        SELECT RAISE(ABORT, 'Git transfer operation or branch belongs to another workspace.');
      END`);
    // No production API changes identity columns, but reject accidental SQL
    // identity reassignment without weakening the cross-workspace invariant.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_exclusive_update
      BEFORE UPDATE OF workspace_id, operation_key, destination, branch
      ON delivery_git_transfers
      WHEN EXISTS (
        SELECT 1 FROM delivery_git_transfers
        WHERE rowid != OLD.rowid AND workspace_id != NEW.workspace_id
          AND (operation_key = NEW.operation_key OR
            (destination COLLATE NOCASE = NEW.destination AND branch = NEW.branch))
      )
      BEGIN
        SELECT RAISE(ABORT, 'Git transfer operation or branch belongs to another workspace.');
      END`);
    // SQLite is the durable trust boundary, including for independent writers
    // that do not use this TypeScript class. Never allow a receipt to appear
    // without a reserved intent, or allow a transfer identity to be reassigned.
    // Existing legacy rows are retained for explicit fail-closed reconciliation.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_intent_only_insert
      BEFORE INSERT ON delivery_git_transfers
      WHEN NEW.state != 'intent' OR NEW.receipt_sha IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'Git transfer insertion must reserve a receipt-free intent.');
      END`);
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_immutable_identity
      BEFORE UPDATE ON delivery_git_transfers
      WHEN OLD.workspace_id IS NOT NEW.workspace_id
        OR OLD.stage IS NOT NEW.stage
        OR OLD.operation_key IS NOT NEW.operation_key
        OR OLD.destination IS NOT NEW.destination
        OR OLD.branch IS NOT NEW.branch
        OR OLD.head_sha IS NOT NEW.head_sha
        OR OLD.base_sha IS NOT NEW.base_sha
      BEGIN
        SELECT RAISE(ABORT, 'Git transfer identity is immutable.');
      END`);
    // A confirmed receipt is permanent; uncertainty cannot be reset to an
    // intent, and only the exact reviewed SHA can complete a stage.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_monotonic_receipt
      BEFORE UPDATE OF state, receipt_sha ON delivery_git_transfers
      WHEN NOT (
        (NEW.state = OLD.state AND NEW.receipt_sha IS OLD.receipt_sha)
        OR (OLD.state = 'intent' AND NEW.state = 'uncertain' AND NEW.receipt_sha IS NULL)
        OR (OLD.state IN ('intent', 'uncertain') AND NEW.state = 'confirmed'
            AND NEW.receipt_sha IS NOT NULL AND NEW.receipt_sha = NEW.head_sha)
      )
      BEGIN
        SELECT RAISE(ABORT, 'Git transfer receipt state must advance monotonically.');
      END`);
    // A push is never independently reservable: its matching commit must
    // already have a durable confirmed receipt, including for direct SQL
    // writers and competing processes that bypass this TypeScript class.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_push_requires_commit_insert
      BEFORE INSERT ON delivery_git_transfers
      WHEN NEW.stage = 'push' AND NOT EXISTS (
        SELECT 1 FROM delivery_git_transfers
        WHERE workspace_id = NEW.workspace_id AND stage = 'commit'
          AND operation_key = NEW.operation_key
          AND destination = NEW.destination AND branch = NEW.branch
          AND head_sha = NEW.head_sha AND base_sha = NEW.base_sha
          AND state = 'confirmed' AND receipt_sha = NEW.head_sha
      )
      BEGIN
        SELECT RAISE(ABORT, 'Push intent requires matching confirmed commit receipt.');
      END`);
    // Preserve the same cross-stage guarantee at receipt confirmation.
    // This also fails closed on pre-upgrade malformed commit rows.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_push_requires_commit_update
      BEFORE UPDATE OF state, receipt_sha ON delivery_git_transfers
      WHEN NEW.stage = 'push' AND NEW.state = 'confirmed' AND NOT EXISTS (
        SELECT 1 FROM delivery_git_transfers
        WHERE workspace_id = NEW.workspace_id AND stage = 'commit'
          AND operation_key = NEW.operation_key
          AND destination = NEW.destination AND branch = NEW.branch
          AND head_sha = NEW.head_sha AND base_sha = NEW.base_sha
          AND state = 'confirmed' AND receipt_sha = NEW.head_sha
      )
      BEGIN
        SELECT RAISE(ABORT, 'Push receipt requires matching confirmed commit receipt.');
      END`);
    // Never erase a durable attempt or its evidence via accidental direct
    // SQL deletion. Legacy conflicts require explicit offline investigation;
    // automatic cleanup would permit replay of an ambiguous remote write.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS delivery_git_transfers_no_delete
      BEFORE DELETE ON delivery_git_transfers
      BEGIN
        SELECT RAISE(ABORT, 'Git transfer intents and receipts cannot be deleted.');
      END`);
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
   * Stable, bounded discovery of unresolved workspaces. A workspace with both
   * commit and push intents appears once. Cursor pagination avoids repeatedly
   * selecting the first blocked workspace during operator-driven recovery.
   * This performs no recovery or journal mutation.
   */
  listUnresolvedWorkspaces(
    limit: number,
    afterWorkspaceId?: string,
  ): { workspaceIds: string[]; nextCursor: string | null; hasMore: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid Git transfer recovery batch limit.');
    }
    if (
      afterWorkspaceId !== undefined &&
      (typeof afterWorkspaceId !== 'string' ||
        afterWorkspaceId.length === 0 ||
        afterWorkspaceId.length > 200)
    ) {
      throw new Error('Invalid Git transfer recovery cursor.');
    }
    const rows =
      afterWorkspaceId === undefined
        ? this.db
            .prepare(
              "SELECT DISTINCT workspace_id FROM delivery_git_transfers WHERE state != 'confirmed' ORDER BY workspace_id LIMIT ?",
            )
            .all(limit + 1)
        : this.db
            .prepare(
              "SELECT DISTINCT workspace_id FROM delivery_git_transfers WHERE state != 'confirmed' AND workspace_id > ? ORDER BY workspace_id LIMIT ?",
            )
            .all(afterWorkspaceId, limit + 1);
    const hasMore = rows.length > limit;
    const workspaceIds = rows.slice(0, limit).map((row) => String(row.workspace_id));
    return {
      workspaceIds,
      nextCursor: hasMore ? workspaceIds[workspaceIds.length - 1]! : null,
      hasMore,
    };
  }

  /**
   * One reservation per workspace/stage, including after restart. SQLite
   * triggers atomically exclude a foreign workspace claiming this operation
   * key or destination/branch, even across independent writer processes.
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

  /**
   * A reviewed branch and publication operation have one durable owner across
   * all workspaces, including interrupted and uncertain attempts. Older
   * journals may predate this invariant: refuse Draft PR eligibility rather
   * than silently adopting, deleting, or replaying a foreign intent. GitHub\n   * repository names are case-insensitive, while Git branch names are not.
   *
   * This read-only gate also protects receipt reconciliation of pre-upgrade
   * conflicting rows. The trusted executor must still hold the
   * shared repository lease, refresh the registry and attest both Git refs.
   */
  assertExclusiveOwnership(identity: DeliveryGitTransferIdentity): void {
    const competing = this.db
      .prepare(
        `SELECT 1 FROM delivery_git_transfers
         WHERE workspace_id != ?
           AND (operation_key = ? OR (destination COLLATE NOCASE = ? AND branch = ?))
         LIMIT 1`,
      )
      .get(identity.workspaceId, identity.operationKey, identity.destination, identity.branch);
    if (competing) {
      throw new Error('Git transfer operation or branch belongs to another workspace.');
    }
  }

  /** Both independent receipts and exclusive ownership are required for Draft PR. */
  assertReadyForDraft(identity: DeliveryGitTransferIdentity) {
    this.assertConfirmed('commit', identity);
    this.assertConfirmed('push', identity);
    this.assertExclusiveOwnership(identity);
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
