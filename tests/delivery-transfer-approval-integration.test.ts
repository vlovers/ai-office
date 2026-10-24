import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DeliveryTransferApprovalLedger,
  type DeliveryTransferApprovalBinding,
} from '../src/server/delivery-transfer-approval.js';

const binding: DeliveryTransferApprovalBinding = {
  stage: 'commit',
  operator: { operatorId: 'operator-a', sessionId: 'session-a' },
  identity: {
    workspaceId: 'workspace-a',
    operationKey: 'operation-a',
    destination: 'https://github.com/vlovers/ai-office',
    branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  },
};

describe('durable Git transfer approval integration', () => {
  it('prevents replay across independent SQLite connections and restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-transfer-approvals-'));
    const path = join(directory, 'approvals.sqlite');
    const firstDb = new DatabaseSync(path);
    const secondDb = new DatabaseSync(path);
    try {
      const first = new DeliveryTransferApprovalLedger(firstDb, () => 1000);
      const second = new DeliveryTransferApprovalLedger(secondDb, () => 1000);
      const approvalId = first.issue(binding);
      second.assertPending(approvalId, binding);
      first.consume(approvalId, binding);
      expect(() => second.consume(approvalId, binding)).toThrow('already consumed');
      expect(() => second.assertPending(approvalId, binding)).toThrow();
    } finally {
      firstDb.close();
      secondDb.close();
    }
    const restartedDb = new DatabaseSync(path);
    try {
      const restarted = new DeliveryTransferApprovalLedger(restartedDb, () => 1000);
      const consumed = restartedDb
        .prepare('SELECT approval_id FROM delivery_transfer_approvals WHERE consumed_at IS NOT NULL')
        .all();
      expect(consumed).toHaveLength(1);
      const receipt = consumed[0];
      if (!receipt) throw new Error('Expected one durable consumed approval.');
      expect(() => restarted.consume(String(receipt.approval_id), binding)).toThrow();
    } finally {
      restartedDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps revocation durable and rejects operator/session impersonation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-transfer-revocation-'));
    const path = join(directory, 'approvals.sqlite');
    const db = new DatabaseSync(path);
    let approvalId: string;
    try {
      const ledger = new DeliveryTransferApprovalLedger(db, () => 2000);
      approvalId = ledger.issue(binding);
      expect(
        ledger.revoke(approvalId, { operatorId: 'operator-a', sessionId: 'wrong-session' }),
      ).toBe(false);
      expect(ledger.revoke(approvalId, binding.operator)).toBe(true);
    } finally {
      db.close();
    }
    const restartedDb = new DatabaseSync(path);
    try {
      const restarted = new DeliveryTransferApprovalLedger(restartedDb, () => 2000);
      expect(() => restarted.consume(approvalId, binding)).toThrow();
      expect(restarted.revoke(approvalId, binding.operator)).toBe(false);
    } finally {
      restartedDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists the clock watermark and rejects backward time after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-transfer-clock-'));
    const path = join(directory, 'approvals.sqlite');
    const db = new DatabaseSync(path);
    try {
      const ledger = new DeliveryTransferApprovalLedger(db, () => 5000);
      ledger.issue(binding);
    } finally {
      db.close();
    }
    const restartedDb = new DatabaseSync(path);
    try {
      const restarted = new DeliveryTransferApprovalLedger(restartedDb, () => 4999);
      expect(() => restarted.issue(binding)).toThrow('moved backwards');
      expect(restartedDb.prepare('SELECT count(*) AS n FROM delivery_transfer_approvals').get()?.n).toBe(1);
    } finally {
      restartedDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
