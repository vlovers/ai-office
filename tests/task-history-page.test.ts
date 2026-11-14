import { describe, expect, it } from 'vitest';
import { TASK_HISTORY_PAGE_SIZE, taskHistoryPage } from '../src/web/task-history-page.js';

const tasks = Array.from({ length: 125 }, (_, index) => ({
  id: `task-${index}`,
  title: `Task ${index}`,
}));

describe('progressive task history', () => {
  it('limits the initial render and loads subsequent batches without mutating history', () => {
    const first = taskHistoryPage(tasks, TASK_HISTORY_PAGE_SIZE);
    expect(first.rows).toEqual(tasks.slice(0, 40));
    expect(first.remaining).toBe(85);

    const second = taskHistoryPage(tasks, TASK_HISTORY_PAGE_SIZE * 2);
    expect(second.rows).toEqual(tasks.slice(0, 80));
    expect(second.remaining).toBe(45);

    const last = taskHistoryPage(tasks, 160);
    expect(last.rows).toEqual(tasks);
    expect(last.remaining).toBe(0);
    expect(tasks).toHaveLength(125);
  });

  it('pins a selected row outside the current page without rendering the intervening rows', () => {
    const page = taskHistoryPage(tasks, 40, 'task-120');
    expect(page.rows).toHaveLength(41);
    expect(page.rows[0]).toBe(tasks[120]);
    expect(page.rows.slice(1)).toEqual(tasks.slice(0, 40));
    expect(page.pinnedSelectedId).toBe('task-120');
    expect(new Set(page.rows.map((task) => task.id)).size).toBe(41);

    const expanded = taskHistoryPage(tasks, 125, 'task-120');
    expect(expanded.rows).toHaveLength(125);
    expect(expanded.pinnedSelectedId).toBeUndefined();
  });

  it('does not duplicate selected rows already in the page or outside the filtered results', () => {
    expect(taskHistoryPage(tasks, 40, 'task-4').rows).toHaveLength(40);
    expect(taskHistoryPage(tasks, 40, 'filtered-out').rows).toHaveLength(40);
    expect(taskHistoryPage([], 40, 'task-120')).toEqual({ rows: [], remaining: 0 });
  });

  it('clamps invalid limits instead of mounting an unbounded history', () => {
    for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const page = taskHistoryPage(tasks, limit);
      expect(page.rows).toHaveLength(0);
      expect(page.remaining).toBe(125);
    }
  });
});
