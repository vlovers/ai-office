import type { Task } from '../shared/types.js';

/** A local-only, read-only CSV projection. No transcripts, prompts, paths or secrets. */
export type ExportTask = Pick<
  Task,
  'id' | 'title' | 'state' | 'agentId' | 'repositoryId' | 'createdAt' | 'updatedAt'
>;

const columns = ['Task ID', 'Title', 'State', 'Agent ID', 'Repository ID', 'Created at', 'Updated at'];

/** Prefix spreadsheet formula-like values to prevent CSV formula execution on open. */
export function csvCell(value: string): string {
  const safe = /^[\s\uFEFF\u200B]*[=+@\-]/u.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function exportTaskHistoryCsv(tasks: readonly ExportTask[]): string {
  const rows = tasks.map((task) =>
    [
      task.id,
      task.title,
      task.state,
      task.agentId,
      task.repositoryId,
      task.createdAt,
      task.updatedAt,
    ].map((value) => csvCell(value ?? '')).join(','),
  );
  return [columns.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}
