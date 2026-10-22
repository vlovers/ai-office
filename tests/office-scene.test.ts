import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PixelOffice, type OfficeAgent } from '../src/web/pixel-art.js';
import { OFFICE_LAYOUT } from '../src/web/office-layout.js';

const agents: OfficeAgent[] = [
  {
    id: 'codex-1',
    name: 'Codex 01',
    status: { state: 'thinking', label: 'Thinking · SDK reasoning item' },
  },
  { id: 'codex-2', name: 'Codex 02', status: { state: 'error', label: 'Selected task failed' } },
];
const render = (slots = agents) =>
  renderToStaticMarkup(
    createElement(PixelOffice, {
      agents: slots,
      selectedAgent: 'codex-1',
      onSelect: () => {},
    }),
  );

it('renders one room with separately identified, keyboard-accessible real workstations', () => {
  const markup = render();
  expect(markup.match(/class="shared-office isometric-office"/g)).toHaveLength(1);
  expect(markup.match(/role="button"/g)).toHaveLength(2);
  expect(markup.match(/tabindex="0"/g)).toHaveLength(2);
  expect(markup).toContain('data-agent-id="codex-1" data-state="thinking"');
  expect(markup).toContain('data-agent-id="codex-2" data-state="error"');
  expect(markup).toContain('aria-label="Select Codex 01 workstation" aria-pressed="true"');
  expect(markup).toContain('aria-label="Select Codex 02 workstation" aria-pressed="false"');
  expect(markup).toContain('Thinking · SDK reasoning item. Read only.');
  expect(markup).toContain('aria-label="Agent workflow overview"');
});

it('never creates characters or interactive agents missing from the runtime', () => {
  expect(render([])).not.toContain('role="button"');
  const markup = render([agents[1]!]);
  expect(markup.match(/role="button"/g)).toHaveLength(1);
  expect(markup).not.toContain('Select Codex 01');
  expect(markup).toContain('Select Codex 02');
});

it('places each identity independently in wide and portrait layouts', () => {
  expect(new Set(OFFICE_LAYOUT.map((station) => station.agentId)).size).toBe(OFFICE_LAYOUT.length);
  expect(OFFICE_LAYOUT[0]!.landscape.x).not.toBe(OFFICE_LAYOUT[1]!.landscape.x);
  expect(OFFICE_LAYOUT[0]!.portrait.y).not.toBe(OFFICE_LAYOUT[1]!.portrait.y);
  expect(OFFICE_LAYOUT[0]!.identity).not.toBe(OFFICE_LAYOUT[1]!.identity);
});

it('uses two desks for active and selected dynamic profiles without inventing IDs or HTML', () => {
  const dynamic: OfficeAgent[] = [
    { id: 'profile-a', name: '<script>unsafe</script>', status: { state: 'idle', label: 'Idle' } },
    { id: 'profile-b', name: 'Second', status: { state: 'idle', label: 'Idle' }, active: true },
    { id: 'profile-c', name: 'Third', status: { state: 'idle', label: 'Idle' } },
  ];
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, { agents: dynamic, selectedAgent: 'profile-c', onSelect: () => {} }),
  );
  expect(markup.match(/role="button"/g)).toHaveLength(2);
  expect(markup).toContain('data-agent-id="profile-b"');
  expect(markup).toContain('data-agent-id="profile-c"');
  expect(markup).not.toContain('data-agent-id="profile-a"');
  const selectedActive = renderToStaticMarkup(
    createElement(PixelOffice, { agents: dynamic, selectedAgent: 'profile-b', onSelect: () => {} }),
  );
  expect(selectedActive.match(/role="button"/g)).toHaveLength(2);
  expect(selectedActive).toContain('&lt;script&gt;');
  expect(selectedActive).not.toContain('<script>');
});

it('shows only real queued tasks, waiting reasons, and their assigned agents', () => {
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, {
      agents,
      selectedAgent: 'codex-1',
      onSelect: () => {},
      queue: [
        { taskId: 'task-b', agentId: 'codex-2', title: 'Review changes', order: 2 },
        {
          taskId: 'task-a',
          agentId: 'codex-1',
          title: 'Implement API',
          order: 1,
          waitingReason: 'Workspace busy',
        },
      ],
    }),
  );
  expect(markup).toContain('aria-label="Live task queue"');
  expect(markup).toContain('2 waiting');
  expect(markup.indexOf('Implement API')).toBeLessThan(markup.indexOf('Review changes'));
  expect(markup).toContain('Workspace busy');
  expect(markup).toContain('Inspect agent assigned to Review changes');
  expect(render()).toContain('No queued tasks.');
});

it('inspects selected live agent without inventing assignments or access', () => {
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, {
      agents: [
        {
          ...agents[0]!,
          taskTitle: 'Build service',
          taskState: 'running',
          role: 'Coder',
          access: 'read-only',
        },
        agents[1]!,
      ],
      selectedAgent: 'codex-1',
      onSelect: () => {},
      queue: [{ taskId: 'next', agentId: 'codex-1', title: 'Review service', order: 1 }],
    }),
  );
  expect(markup).toContain('aria-label="Selected agent inspector"');
  expect(markup).toContain('Build service');
  expect(markup).toContain('Task lifecycle: running');
  expect(markup).toContain('aria-label="Selected task lifecycle"');
  expect(markup).toContain('aria-current="step">running</li>');
  expect(markup).toContain('1 queued for this agent');
  expect(markup).toContain('Execution access: read-only');
  expect(render()).toContain('No running assignment');
});

it('renders latest persisted task activity without fabricating tasks', () => {
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, {
      agents,
      selectedAgent: 'codex-1',
      onSelect: () => {},
      recentTasks: [
        {
          id: 'older',
          agentId: 'codex-1',
          title: 'Earlier review',
          state: 'completed',
          updatedAt: '2026-10-20T10:00:00Z',
        },
        {
          id: 'newer',
          agentId: 'codex-2',
          title: 'Latest QA',
          state: 'failed',
          updatedAt: '2026-10-21T11:00:00Z',
        },
      ],
    }),
  );
  expect(markup).toContain('aria-label="Recent agent tasks"');
  expect(markup.indexOf('Latest QA')).toBeLessThan(markup.indexOf('Earlier review'));
  expect(markup).toContain('Inspect agent for Latest QA');
  expect(markup).toContain('state-failed');
  expect(render()).toContain('No recorded tasks.');
});
