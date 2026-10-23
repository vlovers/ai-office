import { describe, expect, it } from 'vitest';
import { exportWorkflowOperationsCsv } from '../src/web/workflow-operations-export.js';

const workflow = {
  id: 'workflow-1',
  repositoryId: 'repo-1',
  state: 'blocked',
  version: 4,
  updatedAt: '2026-10-24T00:00:00Z',
  stages: [{ state: 'awaiting_approval' }],
};

describe('workflow operations CSV export', () => {
  it('exports deterministic metadata and derives triage from persisted stage states', () => {
    const csv = exportWorkflowOperationsCsv([workflow]);
    expect(csv).toContain('"Workflow ID","Repository ID","State","Triage","Version","Updated at"');
    expect(csv).toContain('"workflow-1","repo-1","blocked","approval","4"');
    expect(csv).not.toContain('awaiting_approval');
    expect(csv).not.toContain('command');
  });

  it('escapes malicious workflow and repository identifiers', () => {
    const csv = exportWorkflowOperationsCsv([
      { ...workflow, id: '=HYPERLINK("x")', repositoryId: '+SUM(1,1)' },
    ]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"\'+SUM(1,1)"');
  });

  it('keeps empty exports header-only and never mutates input', () => {
    expect(exportWorkflowOperationsCsv([]).split('\r\n')).toHaveLength(2);
    const item = Object.freeze({ ...workflow });
    exportWorkflowOperationsCsv([item]);
    expect(item.state).toBe('blocked');
  });
});
