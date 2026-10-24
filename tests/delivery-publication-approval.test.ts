import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeliveryPublicationApprovalLedger,
  type PublicationApprovalBinding,
} from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const binding: PublicationApprovalBinding = {
  workspaceId: 'workspace-1',
  operator: { operatorId: 'operator-1', sessionId: 'session-1' },
  plan,
  commits: {
    operationKey: publicationKey(plan),
    headCommitSha: '1'.repeat(40),
    baseCommitSha: '2'.repeat(40),
  },
};

describe('durable single-use publication approval ledger', () => {
  it('binds approval to exact workspace, session, review and both commits', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db, () => 10_000);
      const id = ledger.issue(binding);
      ledger.assertPending(id, binding);
      const wrong = [
        { ...binding, workspaceId: 'workspace-2' },
        { ...binding, operator: { ...binding.operator, operatorId: 'other' } },
        { ...binding, operator: { ...binding.operator, sessionId: 'other' } },
        { ...binding, plan: { ...plan, revision: 'b'.repeat(64) } },
        { ...binding, commits: { ...binding.commits, headCommitSha: '3'.repeat(40) } },
        { ...binding, commits: { ...binding.commits, baseCommitSha: '3'.repeat(40) } },
      ];
      for (const mismatch of wrong) {
        expect(() => ledger.assertPending(id, mismatch)).toThrow();
        expect(() => ledger.consume(id, mismatch)).toThrow();
      }
      ledger.consume(id, binding);
      expect(() => ledger.consume(id, binding)).toThrow('already consumed');
      expect(() => ledger.assertPending(id, binding)).toThrow('no longer valid');
    } finally {
      db.close();
    }
  });

  it('expires approvals and never accepts a future-issued approval after clock rollback', () => {
    const db = new DatabaseSync(':memory:');
    let now = 10_000;
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db, () => now);
      const id = ledger.issue(binding, 1000);
      now = 9_999;
      expect(() => ledger.consume(id, binding)).toThrow('clock moved backwards');
      now = 11_000;
      expect(() => ledger.assertPending(id, binding)).toThrow();
      expect(() => ledger.consume(id, binding)).toThrow();
      now = 10_500;
      expect(() => ledger.assertPending(id, binding)).toThrow('clock moved backwards');
    } finally {
      db.close();
    }
  });

  it('supports explicit revocation and rejects other sessions', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db);
      const id = ledger.issue(binding);
      expect(ledger.revoke(id, { ...binding.operator, sessionId: 'other' })).toBe(false);
      ledger.assertPending(id, binding);
      expect(ledger.revoke(id, binding.operator)).toBe(true);
      expect(ledger.revoke(id, binding.operator)).toBe(false);
      expect(() => ledger.consume(id, binding)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects blocked plans, malformed identities, SHAs and excessive lifetimes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db);
      expect(() => ledger.issue({ ...binding, plan: { allowed: false, reason: 'stale' } })).toThrow();
      expect(() => ledger.issue({ ...binding, workspaceId: '../workspace' })).toThrow();
      expect(() =>
        ledger.issue({ ...binding, operator: { ...binding.operator, sessionId: '' } }),
      ).toThrow();
      expect(() =>
        ledger.issue({ ...binding, commits: { ...binding.commits, baseCommitSha: 'bad' } }),
      ).toThrow();
      expect(() => ledger.issue(binding, 0)).toThrow('lifetime');
      expect(() => ledger.issue(binding, 16 * 60_000)).toThrow('lifetime');
      expect(() => ledger.assertPending('invalid-id', binding)).toThrow('identifier');
    } finally {
      db.close();
    }
  });

  it('persists the clock watermark across process restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-approval-clock-'));
    const file = join(dir, 'approval.sqlite');
    try {
      const first = new DatabaseSync(file);
      let id: string;
      try {
        const ledger = new DeliveryPublicationApprovalLedger(first, () => 10_000);
        id = ledger.issue(binding, 1000);
      } finally {
        first.close();
      }
      const reopened = new DatabaseSync(file);
      try {
        const backwards = new DeliveryPublicationApprovalLedger(reopened, () => 9_999);
        expect(() => backwards.assertPending(id!, binding)).toThrow('clock moved backwards');
        const expired = new DeliveryPublicationApprovalLedger(reopened, () => 11_000);
        expect(() => expired.consume(id!, binding)).toThrow('expired');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives restart and prevents replay across separate SQLite connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-office-approval-'));
    const file = join(dir, 'approval.sqlite');
    try {
      const db1 = new DatabaseSync(file);
      let id: string;
      try {
        const ledger = new DeliveryPublicationApprovalLedger(db1);
        id = ledger.issue(binding);
      } finally {
        db1.close();
      }
      const db2 = new DatabaseSync(file);
      const db3 = new DatabaseSync(file);
      try {
        const ledger2 = new DeliveryPublicationApprovalLedger(db2);
        const ledger3 = new DeliveryPublicationApprovalLedger(db3);
        ledger2.assertPending(id!, binding);
        ledger3.consume(id!, binding);
        expect(() => ledger2.consume(id!, binding)).toThrow('already consumed');
      } finally {
        db2.close();
        db3.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
