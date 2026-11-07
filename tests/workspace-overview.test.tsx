import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentView, Dashboard, Task } from '../src/shared/types.js';
import { WorkspaceOverview } from '../src/web/workspace-overview.js';

const agent: AgentView = {
  id: 'codex-1',
  name: 'Coder',
  provider: 'codex',
  state: 'idle',
  taskId: null,
  canStop: true,
  mode: 'Repository review · read only',
};

const task = (id: string, state: Task['state']): Task => ({
  id,
  repositoryId: 'repo-1',
  agentId: 'codex-1',
  sessionId: null,
  title: `Task ${id}`,
  prompt: 'Read-only fixture',
  state,
  result: '',
  error: null,
  changedFiles: [],
  baselineFiles: [],
  summaryError: null,
  createdAt: '2026-11-07T12:00:00.000Z',
  updatedAt: '2026-11-07T12:00:00.000Z',
});

const dashboard = (tasks: Task[]): Dashboard => ({
  agents: [agent],
  agent,
  profiles: [],
  repositories: [
    {
      id: 'repo-1',
      name: 'Demo repository',
      path: '/tmp/demo',
      gitDir: '/tmp/demo/.git',
      createdAt: '2026-11-07T12:00:00.000Z',
    },
  ],
  tasks,
  sessions: [],
  queue: [],
  concurrency: 2,
  ready: true,
  readinessMessage: 'Ready',
  connection: {
    mode: 'local-cli-chatgpt',
    status: 'available',
    message: 'Local provider available',
    checkedAt: null,
    modes: [],
  },
});

const render = (data?: Dashboard) =>
  renderToStaticMarkup(
    <WorkspaceOverview dashboard={data} onOpenTask={() => {}} onNewTask={() => {}} />,
  );

describe('minimal workspace overview', () => {
  it('does not fabricate metrics or agents before a snapshot arrives', () => {
    const html = render();
    expect(html).toContain('Loading workspace tasks');
    expect(html).toContain('Loading agents');
    expect(html).toContain('Checking connection');
    expect(html).toContain('<strong>—</strong>');
    expect(html).not.toContain('99.98%');
  });

  it('shows an actionable empty state without fake recent activity', () => {
    const html = render(dashboard([]));
    expect(html).toContain('No tasks yet');
    expect(html).toContain('Create a task');
    expect(html).toContain('Local provider available');
    expect(html).not.toContain('Run completed');
  });

  it('distinguishes submitted queue entries from unsubmitted task drafts', () => {
    const draft = task('draft', 'queued');
    const submitted = task('submitted', 'queued');
    const data = dashboard([
      draft,
      submitted,
      task('running', 'running'),
      task('failed', 'failed'),
      task('completed', 'completed'),
    ]);
    data.queue.push({
      taskId: submitted.id,
      agentId: 'codex-1',
      order: 1,
      enqueuedAt: '2026-11-07T12:00:00.000Z',
      mode: 'local-cli-chatgpt',
      resumeSessionId: null,
    });
    const html = render(data);
    expect(html).toContain('Task draft');
    expect(html).toContain('Task submitted');
    expect(html).toContain('In queue');
    expect(html).toContain('Not started');
    expect(html).toContain('Needs attention');
    expect(html).toContain('Failed');
    expect(html).toContain('Demo repository');
    expect(html).toContain('Open task: Task submitted');
    expect(html).not.toContain('72%');
  });
});

/** TEMPORARY: print exact CI Prettier CSS output to close formatting drift. Remove after capture. */
it('reports the exact workspace theme formatter output', async () => {
  if (process.env.CI !== 'true') return;
  const { readFile } = await import('node:fs/promises');
  const prettier = await import('prettier');
  const path = 'src/web/workspace-theme.css';
  const source = await readFile(path, 'utf8');
  const options = (await prettier.resolveConfig(path)) ?? {};
  const normalized = await prettier.format(source, { ...options, filepath: path });
  if (normalized !== source) {
    const encoded = Buffer.from(normalized, 'utf8').toString('base64');
    const chunkSize = 3000;
    const total = Math.ceil(encoded.length / chunkSize);
    for (let index = 0; index < total; index++) {
      console.info(
        'OFFICE_CSS_FORMAT_' +
          index +
          '_OF_' +
          total +
          '=' +
          encoded.slice(index * chunkSize, (index + 1) * chunkSize),
      );
    }
  }
});
