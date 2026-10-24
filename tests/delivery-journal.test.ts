import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryJournal } from '../src/server/delivery-journal.js';

describe('delivery journal', () => {
  it('reserves once, publishes once and reuses the exact receipt', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      expect(journal.reserve('workspace-1', 'operation-a').state).toBe('reserved');
      expect(journal.reserve('workspace-1', 'operation-a').state).toBe('reserved');
      expect(() => journal.reserve('workspace-1', 'operation-b')).toThrow();
      const url = 'https://github.com/vlovers/ai-office/pull/45';
      expect(journal.publish('workspace-1', 'operation-a', url).state).toBe('published');
      expect(journal.publish('workspace-1', 'operation-a', url).pullRequestUrl).toBe(url);
      expect(() =>
        journal.publish('workspace-1', 'operation-a', 'https://github.com/vlovers/ai-office/pull/46'),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('marks interrupted reservations uncertain and blocks publication', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-2', 'operation-a');
      journal.recoverInterrupted();
      expect(journal.get('workspace-2')?.state).toBe('uncertain');
      expect(() =>
        journal.publish('workspace-2', 'operation-a', 'https://github.com/vlovers/ai-office/pull/45'),
      ).toThrow();
      expect(() => journal.reserve('workspace-2', 'operation-b')).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects untrusted PR URLs and preserves the reservation', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new DeliveryJournal(db);
      journal.reserve('workspace-3', 'operation-a');
      expect(() => journal.publish('workspace-3', 'operation-a', 'https://evil.example/pull/1')).toThrow();
      expect(journal.get('workspace-3')?.state).toBe('reserved');
      expect(journal.markUncertain('workspace-3', 'operation-a')?.state).toBe('uncertain');
    } finally {
      db.close();
    }
  });
});
