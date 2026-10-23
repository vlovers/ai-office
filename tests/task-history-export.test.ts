import { describe, expect, it } from 'vitest';
import { exportTaskHistoryCsv, type ExportTask } from '../src/web/task-history-export.js';

const sample = {
  id: 'task-1',
  title: 'Review changes',
  state: 'completed',
  agentId: 'agent-1',
  repositoryId: 'repo-1',
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T01:00:00Z',
} satisfies ExportTask;

describe('task history CSV export', () => {
  it('exports a deterministic, minimal header and selected rows', () => {
    const csv = exportTaskHistoryCsv([sample]);
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('"Task ID","Title","State","Agent ID"');
    expect(csv).toContain('"task-1","Review changes","completed"');
    expect(csv).not.toContain('prompt');
    expect(exportTaskHistoryCsv([]).split('\r\n')).toHaveLength(2);
  });

  it('quotes commas, quotes and line breaks without losing the original value', () => {
    expect(exportTaskHistoryCsv([{ ...sample, title: 'One, "two"\nthree' }])).toContain(
      '"One, ""two""\nthree"',
    );
  });

  it.each(['=SUM(1,1)', '+cmd', '-2+3', '@foo', '  =HYPERLINK("x")', '\t=1', '\r+1'])(
    'neutralizes spreadsheet formulas: %s',
    (title) => {
      expect(exportTaskHistoryCsv([{ ...sample, title }])).toContain(
        '"' + "'" + title.replace(/"/g, '""') + '"',
      );
    },
  );

  it('neutralizes formula prefixes in IDs and repository metadata too', () => {
    const csv = exportTaskHistoryCsv([
      { ...sample, id: '=1+1', agentId: '@user', repositoryId: '-SUM(1,2)' },
    ]);
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"\'@user"');
    expect(csv).toContain('"\'-SUM(1,2)"');
  });

  it('does not mutate source task objects', () => {
    const input = Object.freeze({ ...sample });
    exportTaskHistoryCsv([input]);
    expect(input.title).toBe('Review changes');
  });
});
