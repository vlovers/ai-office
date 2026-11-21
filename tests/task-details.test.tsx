import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/shared/types.js';
import { TaskDetails, TaskTimeline } from '../src/web/task-details.js';
import { decodeTaskNavigation, encodeTaskNavigation } from '../src/web/task-navigation.js';
import { routeFromHash } from '../src/web/destinations.js';
import { settingsSectionFromHash } from '../src/web/settings-page.js';

const task: Task = {
  id: 'task / #201',
  title: 'Improve animation system',
  prompt: 'Review animation performance.',
  state: 'completed',
  repositoryId: 'repo',
  agentId: 'codex-1',
  sessionId: null,
  result: '',
  error: null,
  baselineFiles: [],
  changedFiles: [],
  summaryError: null,
  createdAt: '2026-11-21T10:00:00Z',
  updatedAt: '2026-11-21T10:01:00Z',
};

describe('task detail routes and truthful metadata', () => {
  it.each(['overview', 'execution', 'changes', 'review', 'history'] as const)(
    'round-trips the %s tab and preserves task identity',
    (destination) => {
      for (const context of [undefined, 'overview'] as const) {
        const target = { taskId: task.id, destination, ...(context ? { context } : {}) };
        const hash = encodeTaskNavigation(target);
        expect(decodeTaskNavigation(hash)).toEqual(target);
        expect(routeFromHash(hash)).toEqual({
          page: context ? 'office' : 'tasks',
          taskPanel: 'details',
          view: context ? 'mission' : 'focus',
        });
      }
    },
  );
  it('shows actual state and objective without inventing estimates or criteria', () => {
    const html = renderToStaticMarkup(
      <TaskDetails
        task={task}
        events={[]}
        destination="overview"
        connected={false}
        controls={null}
        execution="Execution fixture"
        changes="Changes fixture"
        review={null}
        workflow={null}
        onNavigate={() => {}}
        api={async <T,>() => ({}) as T}
      />,
    );
    expect(html).toContain(task.prompt);
    expect(html).toContain('Latest saved state: completed');
    expect(html).toContain('Not recorded');
    expect(html).toContain('No isolated worktree recorded.');
    expect(html).toContain('Disconnected. Task details show the last received snapshot.');
    expect(html).not.toContain('60%');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain(
      'id="task-content-execution" role="tabpanel" aria-labelledby="task-tab-execution" hidden=""',
    );
    expect(html).toContain('disabled="" title="Available after an isolated write task finishes"');
  });
  it('uses only state events belonging to the selected task in its timeline', () => {
    const html = renderToStaticMarkup(
      <TaskTimeline
        task={task}
        events={[
          {
            id: 1,
            taskId: task.id,
            at: task.updatedAt,
            kind: 'state',
            message: 'Execution finished',
          },
          {
            id: 2,
            taskId: 'other-task',
            at: task.updatedAt,
            kind: 'state',
            message: 'Foreign event',
          },
          { id: 3, taskId: task.id, at: task.updatedAt, kind: 'output', message: 'Private output' },
        ]}
      />,
    );
    expect(html).toContain('Execution finished');
    expect(html).not.toContain('Foreign event');
    expect(html).not.toContain('Private output');
  });
  it('allowlists settings subroutes and retains legacy links', () => {
    expect(settingsSectionFromHash('#repositories')).toBe('Repositories');
    expect(settingsSectionFromHash('#connection')).toBe('Integrations');
    expect(settingsSectionFromHash('#settings/security')).toBe('Security');
    expect(settingsSectionFromHash('#settings/delete')).toBe('General');
    expect(routeFromHash('#settings/execution').page).toBe('settings');
  });
});
