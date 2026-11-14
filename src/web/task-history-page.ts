/** Keep large persisted task histories responsive without hiding a selected task. */
export const TASK_HISTORY_PAGE_SIZE = 40;

export function taskHistoryPage<T extends { id: string }>(
  tasks: readonly T[],
  limit: number,
  selectedId?: string,
): { rows: T[]; remaining: number; pinnedSelectedId?: string } {
  const count = Math.min(tasks.length, Number.isSafeInteger(limit) ? Math.max(0, limit) : 0);
  const rows = tasks.slice(0, count);
  const selected = selectedId
    ? tasks.find((task, index) => index >= count && task.id === selectedId)
    : undefined;

  // The selected task remains accessible without mounting every preceding row.
  if (selected) rows.unshift(selected);

  return {
    rows,
    remaining: tasks.length - count,
    ...(selected ? { pinnedSelectedId: selected.id } : {}),
  };
}
