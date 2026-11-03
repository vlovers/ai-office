import { describe, expect, it } from 'vitest';
import { assertWorkflowSnapshotCoherent } from '../src/web/workflow-snapshot-coherence.js';

const id = 'workflow-a';
const summary = { id, version: 7 };
const timeline = { id, version: 7 };
const diagnostics = { id, version: 7 };

describe('workflow snapshot coherence across read-only endpoints', () => {
  it('accepts matching workflow identities and persisted versions', () => {
    expect(() => assertWorkflowSnapshotCoherent(id, summary, timeline, diagnostics)).not.toThrow();
  });

  it.each([
    ['summary', { id: 'workflow-b', version: 7 }, timeline, diagnostics],
    ['timeline', summary, { id: 'workflow-b', version: 7 }, diagnostics],
    ['diagnostics', summary, timeline, { id: 'workflow-b', version: 7 }],
  ])('rejects a different %s workflow identity', (_source, listed, viewed, diagnosed) => {
    expect(() => assertWorkflowSnapshotCoherent(id, listed, viewed, diagnosed)).toThrow(
      'Workflow checkpoint identity mismatch; refresh to retry',
    );
  });

  it.each([
    ['summary advanced', { id, version: 8 }, timeline, diagnostics],
    ['timeline advanced', summary, { id, version: 8 }, diagnostics],
    ['diagnostics advanced', summary, timeline, { id, version: 8 }],
  ])('rejects mixed persisted versions when %s', (_source, listed, viewed, diagnosed) => {
    expect(() => assertWorkflowSnapshotCoherent(id, listed, viewed, diagnosed)).toThrow(
      'Workflow checkpoint changed during refresh; retry to verify current version',
    );
  });

  it('rejects incomplete snapshots rather than trusting an absent endpoint', () => {
    expect(() => assertWorkflowSnapshotCoherent(id, undefined, timeline, diagnostics)).toThrow(
      'Workflow checkpoint incomplete; refresh to retry',
    );
    expect(() => assertWorkflowSnapshotCoherent(id, summary, null, diagnostics)).toThrow(
      'Workflow checkpoint incomplete; refresh to retry',
    );
    expect(() => assertWorkflowSnapshotCoherent(id, summary, timeline, null)).toThrow(
      'Workflow checkpoint incomplete; refresh to retry',
    );
  });
});
