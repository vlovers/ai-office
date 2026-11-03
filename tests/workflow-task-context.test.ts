import { describe, expect, it } from 'vitest';
import { workflowsForTask } from '../src/web/workflow-task-context.js';

const workflows = [
  {
    id: 'multi-stage',
    stages: [{ taskId: 'coder' }, { taskId: 'reviewer' }, { taskId: 'qa' }],
  },
  { id: 'another', stages: [{ taskId: 'other' }, { taskId: null }] },
  { id: 'unbound', stages: [{ taskId: null }] },
];

describe('task-scoped workflow review', () => {
  it.each(['coder', 'reviewer', 'qa'])(
    'finds a workflow linked through its %s task',
    (taskId) => {
      expect(workflowsForTask(workflows, taskId).map((item) => item.id)).toEqual([
        'multi-stage',
      ]);
    },
  );

  it('does not expose unrelated or unbound workflows', () => {
    expect(workflowsForTask(workflows, 'missing')).toEqual([]);
    expect(workflowsForTask(workflows, 'other').map((item) => item.id)).toEqual(['another']);
  });

  it('preserves all workflows and order outside a task-specific view', () => {
    expect(workflowsForTask(workflows)).toEqual(workflows);
    expect(workflowsForTask(workflows, '')).toEqual(workflows);
  });

  it('returns a workflow once even if a task appears in multiple stages', () => {
    const duplicated = [{ id: 'shared', stages: [{ taskId: 'shared' }, { taskId: 'shared' }] }];
    expect(workflowsForTask(duplicated, 'shared')).toEqual(duplicated);
  });

  it('does not mutate the source list', () => {
    const original = workflows.slice();
    workflowsForTask(workflows, 'qa');
    expect(workflows).toEqual(original);
  });
});
