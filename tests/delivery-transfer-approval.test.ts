import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DeliveryTransferApprovalLedger,
  type DeliveryTransferApprovalBinding,
} from '../src/server/delivery-transfer-approval.js';

const binding: DeliveryTransferApprovalBinding = {
  stage: 'commit',
  operator: { operatorId: 'operator-1', sessionId: 'session-1' },
  identity: {
    workspaceId: 'workspace-1',
    operationKey: 'operation-1',
    destination: 'https://github.com/vlovers/ai-office',
    branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  },
};

describe('Git transfer operator approvals', () => {
  it('consumes each stage approval once and prevents cross-stage replay', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryTransferApprovalLedger(db, () => 1000);
      const id = ledger.issue(binding);
      expect(() => ledger.assertPending(id, { ...binding, stage: 'push' })).toThrow();
      ledger.assertPending(id, binding);
      ledger.consume(id, binding);
      expect(() => ledger.consume(id, binding)).toThrow('already consumed');
      expect(() => ledger.assertPending(id, binding)).toThrow();
      const push = { ...binding, stage: 'push' as const };
      const pushId = ledger.issue(push);
      ledger.consume(pushId, push);
    } finally {
      db.close();
    }
  });

  it('binds operator, session, workspace, destination and reviewed SHA', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryTransferApprovalLedger(db, () => 1000);
      const id = ledger.issue(binding);
      const mismatches: DeliveryTransferApprovalBinding[] = [
        { ...binding, operator: { ...binding.operator, sessionId: 'session-2' } },
        { ...binding, operator: { ...binding.operator, operatorId: 'operator-2' } },
        { ...binding, identity: { ...binding.identity, workspaceId: 'workspace-2' } },
        { ...binding, identity: { ...binding.identity, destination: 'https://github.com/other/repo' } },
        { ...binding, identity: { ...binding.identity, headSha: 'c'.repeat(40) } },
        { ...binding, identity: { ...binding.identity, operationKey: 'operation-2' } },
      ];
      for (const mismatch of mismatches) {
        expect(() => ledger.consume(id, mismatch)).toThrow();
      }
      ledger.consume(id, binding);
    } finally {
      db.close();
    }
  });

  it('expires, revokes, and rejects backward clocks across instances', () => {
    const db = new DatabaseSync(':memory:');
    let now = 1000;
    try {
      const ledger = new DeliveryTransferApprovalLedger(db, () => now);
      const expiring = ledger.issue(binding, 100);
      now = 1100;
      expect(() => ledger.consume(expiring, binding)).toThrow();
      const revoked = ledger.issue(binding);
      expect(ledger.revoke(revoked, { operatorId: 'wrong', sessionId: 'session-1' })).toBe(false);
      expect(ledger.revoke(revoked, binding.operator)).toBe(true);
      expect(() => ledger.consume(revoked, binding)).toThrow();
      now = 1099;
      const restarted = new DeliveryTransferApprovalLedger(db, () => now);
      expect(() => restarted.issue(binding)).toThrow('moved backwards');
    } finally {
      db.close();
    }
  });

  it('rejects invalid identity and excessive lifetimes before inserting rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryTransferApprovalLedger(db, () => 1000);
      expect(() => ledger.issue({ ...binding, identity: { ...binding.identity, branch: 'main' } })).toThrow();
      expect(() => ledger.issue(binding, 900_001)).toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM delivery_transfer_approvals').get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
