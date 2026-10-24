import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserveApprovedPublicationAtomically } from '../src/server/delivery-approved-publication-reservation.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const binding = {
  workspaceId: 'workspace-1',
  operator: { operatorId: 'operator-1', sessionId: 'session-1' },
  plan,
  commits: {
    operationKey: publicationKey(plan),
    headCommitSha: '1'.repeat(40),
    baseCommitSha: '2'.repeat(40),
  },
};

describe('atomic publication approval and journal reservation', () => {
  it('commits both records once and blocks approval replay', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db, () => 10_000);
      const id = ledger.issue(binding);
      const entry = reserveApprovedPublicationAtomically(db, id, binding, () => {}, () => 10_000);
      expect(entry.state).toBe('reserved');
      expect(entry.operationKey).toBe(publicationKey(plan));
      expect(() => ledger.assertPending(id, binding)).toThrow();
      expect(() =>
        reserveApprovedPublicationAtomically(db, id, binding, () => {}, () => 10_000),
      ).toThrow();
      expect(new DeliveryJournal(db).listUnresolved()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rolls back approval consumption when journal already owns the workspace', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db, () => 10_000);
      const journal = new DeliveryJournal(db);
      journal.reserve(binding.workspaceId, 'other-operation');
      const id = ledger.issue(binding);
      expect(() =>
        reserveApprovedPublicationAtomically(db, id, binding, () => {}, () => 10_000),
      ).toThrow();
      ledger.assertPending(id, binding);
      expect(journal.get(binding.workspaceId)?.operationKey).toBe('other-operation');
    } finally {
      db.close();
    }
  });

  it('rejects revoked authorization and asynchronous authorization callbacks', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ledger = new DeliveryPublicationApprovalLedger(db, () => 10_000);
      const journal = new DeliveryJournal(db);
      const id = ledger.issue(binding);
      expect(() =>
        reserveApprovedPublicationAtomically(
          db,
          id,
          binding,
          () => {
            throw new Error('operator revoked');
          },
          () => 10_000,
        ),
      ).toThrow('operator revoked');
      ledger.assertPending(id, binding);
      expect(journal.get(binding.workspaceId)).toBeNull();
      expect(() =>
        reserveApprovedPublicationAtomically(
          db,
          id,
          binding,
          (() => Promise.resolve()) as () => void,
          () => 10_000,
        ),
      ).toThrow('synchronous');
      ledger.assertPending(id, binding);
      expect(ledger.revoke(id, binding.operator)).toBe(true);
      expect(() =>
        reserveApprovedPublicationAtomically(db, id, binding, () => {}, () => 10_000),
      ).toThrow();
      expect(journal.get(binding.workspaceId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('survives a restart and refuses replay through a second SQLite connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-publication-reserve-'));
    const filename = join(directory, 'journal.sqlite');
    try {
      const first = new DatabaseSync(filename);
      let approvalId: string;
      try {
        const approvals = new DeliveryPublicationApprovalLedger(first, () => 10_000);
        approvalId = approvals.issue(binding);
        reserveApprovedPublicationAtomically(first, approvalId, binding, () => {}, () => 10_000);
      } finally {
        first.close();
      }
      const second = new DatabaseSync(filename);
      try {
        const journal = new DeliveryJournal(second);
        expect(journal.get(binding.workspaceId)?.state).toBe('reserved');
        expect(() =>
          reserveApprovedPublicationAtomically(
            second,
            approvalId,
            binding,
            () => {},
            () => 10_000,
          ),
        ).toThrow();
        expect(journal.get(binding.workspaceId)?.operationKey).toBe(publicationKey(plan));
        journal.recoverWorkspace(binding.workspaceId, publicationKey(plan));
        expect(journal.get(binding.workspaceId)?.state).toBe('uncertain');
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a matching duplicate journal reservation without consuming approval', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const approvals = new DeliveryPublicationApprovalLedger(db, () => 10_000);
      const journal = new DeliveryJournal(db);
      journal.reserve(binding.workspaceId, publicationKey(plan));
      const id = approvals.issue(binding);
      expect(() =>
        reserveApprovedPublicationAtomically(db, id, binding, () => {}, () => 10_000),
      ).toThrow('already exists');
      approvals.assertPending(id, binding);
      expect(journal.get(binding.workspaceId)?.state).toBe('reserved');
    } finally {
      db.close();
    }
  });
  it('serializes independent SQLite connections and leaves a single durable reservation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-publication-contention-'));
    const filename = join(directory, 'journal.sqlite');
    const first = new DatabaseSync(filename);
    const second = new DatabaseSync(filename);
    try {
      const approvals = new DeliveryPublicationApprovalLedger(first, () => 10_000);
      const journal = new DeliveryJournal(first);
      const id = approvals.issue(binding);
      const reserved = reserveApprovedPublicationAtomically(
        first,
        id,
        binding,
        () => {},
        () => 10_000,
      );
      expect(reserved.state).toBe('reserved');
      expect(() =>
        reserveApprovedPublicationAtomically(second, id, binding, () => {}, () => 10_000),
      ).toThrow();
      expect(new DeliveryJournal(second).listUnresolved()).toHaveLength(1);
      expect(journal.get(binding.workspaceId)?.operationKey).toBe(publicationKey(plan));
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a revoked authorization on a separate SQLite connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-publication-revoke-'));
    const filename = join(directory, 'journal.sqlite');
    const first = new DatabaseSync(filename);
    const second = new DatabaseSync(filename);
    try {
      const approvals = new DeliveryPublicationApprovalLedger(first, () => 10_000);
      const id = approvals.issue(binding);
      expect(
        new DeliveryPublicationApprovalLedger(second, () => 10_000).revoke(id, binding.operator),
      ).toBe(true);
      expect(() =>
        reserveApprovedPublicationAtomically(first, id, binding, () => {}, () => 10_000),
      ).toThrow();
      expect(new DeliveryJournal(second).get(binding.workspaceId)).toBeNull();
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
