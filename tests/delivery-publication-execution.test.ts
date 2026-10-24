import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { executeReservedPublication } from '../src/server/delivery-publication-execution.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  return { db, journal: new DeliveryJournal(db) };
}
const readiness = { status: 'requires-lease' as const, operationKey: 'snapshot-key' };

describe('reserved publication execution', () => {
  it('records the receipt after exactly one external publication', async () => {
    const { db, journal } = setup();
    try {
      const publish = vi.fn().mockResolvedValue('https://github.com/vlovers/ai-office/pull/123');
      const entry = await executeReservedPublication(journal, 'workspace', readiness, publish);
      expect(entry.state).toBe('published');
      expect(publish).toHaveBeenCalledOnce();
      await expect(
        executeReservedPublication(journal, 'workspace', readiness, publish),
      ).rejects.toThrow('reservation already exists');
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('marks ambiguous failures uncertain and never retries', async () => {
    const { db, journal } = setup();
    try {
      const publish = vi.fn().mockRejectedValue(new Error('network timeout'));
      await expect(
        executeReservedPublication(journal, 'workspace', readiness, publish),
      ).rejects.toThrow('network timeout');
      expect(journal.get('workspace')?.state).toBe('uncertain');
      await expect(
        executeReservedPublication(journal, 'workspace', readiness, publish),
      ).rejects.toThrow('reservation already exists');
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('preserves uncertain state if remote response has an invalid receipt', async () => {
    const { db, journal } = setup();
    try {
      await expect(
        executeReservedPublication(journal, 'workspace', readiness, async () => 'invalid-url'),
      ).rejects.toThrow('Invalid GitHub pull request URL');
      expect(journal.get('workspace')?.state).toBe('uncertain');
    } finally {
      db.close();
    }
  });

  it('never invokes external writes for blocked readiness', async () => {
    const { db, journal } = setup();
    try {
      const publish = vi.fn();
      await expect(
        executeReservedPublication(journal, 'workspace', { status: 'blocked', reason: 'stale' }, publish),
      ).rejects.toThrow('blocked or already completed');
      expect(publish).not.toHaveBeenCalled();
      expect(journal.get('workspace')).toBeNull();
    } finally {
      db.close();
    }
  });
});
