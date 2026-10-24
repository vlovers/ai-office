import type { DatabaseSync } from 'node:sqlite';

export type DeliveryJournalEntry = {
  workspaceId: string;
  operationKey: string;
  state: 'reserved' | 'published' | 'uncertain';
  pullRequestUrl: string | null;
};

export class DeliveryJournal {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_journal (
      workspace_id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'published', 'uncertain')),
      pull_request_url TEXT
    )`);
  }

  get(workspaceId: string): DeliveryJournalEntry | null {
    const row = this.db
      .prepare('SELECT workspace_id, operation_key, state, pull_request_url FROM delivery_journal WHERE workspace_id=?')
      .get(workspaceId);
    if (!row) return null;
    return {
      workspaceId: String(row.workspace_id),
      operationKey: String(row.operation_key),
      state: row.state as DeliveryJournalEntry['state'],
      pullRequestUrl: row.pull_request_url === null ? null : String(row.pull_request_url),
    };
  }

  /**
   * Atomic reservation: only one operation can own a workspace. Even matching
   * retries cannot re-run a write while the first attempt may have succeeded.
   */
  reserve(workspaceId: string, operationKey: string): DeliveryJournalEntry {
    if (!workspaceId || !operationKey) throw new Error('Publication identity is required.');
    this.db
      .prepare(
        "INSERT OR IGNORE INTO delivery_journal (workspace_id, operation_key, state, pull_request_url) VALUES (?, ?, 'reserved', NULL)",
      )
      .run(workspaceId, operationKey);
    const entry = this.get(workspaceId)!;
    if (entry.operationKey !== operationKey)
      throw new Error('Workspace already has a different publication operation.');
    if (entry.state !== 'reserved')
      throw new Error('Publication already completed or requires manual recovery.');
    return entry;
  }

  /**
   * Only the owning operation may transition from reserved to published.
   * A repeated completion with the same URL is harmless; conflicting URLs fail.
   */
  publish(workspaceId: string, operationKey: string, pullRequestUrl: string): DeliveryJournalEntry {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pullRequestUrl))
      throw new Error('Invalid GitHub pull request URL.');
    const updated = this.db
      .prepare(
        "UPDATE delivery_journal SET state='published', pull_request_url=? WHERE workspace_id=? AND operation_key=? AND state='reserved'",
      )
      .run(pullRequestUrl, workspaceId, operationKey);
    if (updated.changes === 1) return this.get(workspaceId)!;
    const existing = this.get(workspaceId);
    if (
      existing?.operationKey === operationKey &&
      existing.state === 'published' &&
      existing.pullRequestUrl === pullRequestUrl
    )
      return existing;
    throw new Error('Publication state changed or requires manual recovery.');
  }

  markUncertain(workspaceId: string, operationKey: string) {
    this.db
      .prepare(
        "UPDATE delivery_journal SET state='uncertain' WHERE workspace_id=? AND operation_key=? AND state='reserved'",
      )
      .run(workspaceId, operationKey);
    return this.get(workspaceId);
  }

  /**
   * After restart, an in-flight reservation is uncertain. Never retry an
   * external GitHub operation until the remote outcome has been reconciled.
   */
  recoverInterrupted() {
    this.db.exec("UPDATE delivery_journal SET state='uncertain' WHERE state='reserved'");
  }
}
