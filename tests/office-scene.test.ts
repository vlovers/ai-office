import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PixelOffice, type OfficeAgent } from '../src/web/pixel-art.js';

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
    createElement(PixelOffice, { agents: slots, selectedAgent: 'codex-1', onSelect: () => {} }),
  );
it('renders one original room with keyboard-accessible real workstations', () => {
  const markup = render();
  expect(markup.match(/class="shared-office isometric-office"/g)).toHaveLength(1);
  expect(markup.match(/role="button"/g)).toHaveLength(2);
  expect(markup.match(/tabindex="0"/g)).toHaveLength(2);
  expect(markup).toContain('data-agent-id="codex-1" data-state="thinking"');
  expect(markup).toContain('aria-label="Select Codex 01 workstation" aria-pressed="true"');
  expect(markup).toContain('Thinking · SDK reasoning item. No active access.');
  expect(markup.match(/class="office-environment"/g)).toHaveLength(1);
});
it('never invents characters when the runtime has no agents', () => {
  const markup = render([]);
  expect(markup).not.toContain('role="button"');
  expect(markup).toContain('Your office is ready for company.');
  expect(markup).toContain('Open Agent Studio');
  expect(render([agents[1]!])).not.toContain('Select Codex 01');
});
it('shows four stable profile desks and reveals a selected overflow profile', () => {
  const profiles = Array.from({ length: 7 }, (_, i) => ({
    ...agents[0]!,
    id: `agent-${i}`,
    name: `Profile ${i}`,
  }));
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, { agents: profiles, selectedAgent: 'agent-6', onSelect: () => {} }),
  );
  expect(markup.match(/role="button"/g)).toHaveLength(4);
  expect(markup).toContain('data-agent-id="agent-6"');
  expect(markup).toContain('3 more profiles in the roster.');
  expect(markup.match(/class="studio-agent state-/g)).toHaveLength(7);
});
it('escapes profile and task names and preserves actual task IDs for inspection', () => {
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, {
      agents: [
        {
          ...agents[0]!,
          name: '<script>unsafe</script>',
          taskId: 'saved-id',
          taskTitle: 'Saved review',
          taskState: 'completed',
          access: 'read-only',
        },
      ],
      selectedAgent: 'codex-1',
      onSelect: () => {},
      onInspectSession: () => {},
      queue: [
        { taskId: 'b', agentId: 'codex-2', title: 'Later', order: 2 },
        {
          taskId: 'a',
          agentId: 'codex-1',
          title: 'First',
          order: 1,
          waitingReason: 'Workspace busy',
        },
      ],
      onInspectTask: () => {},
    }),
  );
  expect(markup).toContain('&lt;script&gt;');
  expect(markup).not.toContain('<script>');
  expect(markup).toContain('Task lifecycle: completed');
  expect(markup).toContain('Inspect task &amp; session');
  expect(markup.indexOf('Inspect queued task First')).toBeLessThan(
    markup.indexOf('Inspect queued task Later'),
  );
  expect(markup).toContain('Workspace busy');
});
it('distinguishes approval, queued and reviewing by text and symbols', () => {
  const markup = render(
    ['approval', 'queued', 'reviewing'].map((state, i) => ({
      ...agents[0]!,
      id: `p${i}`,
      status: { state: state as OfficeAgent['status']['state'], label: state },
    })),
  );
  expect(markup).toContain('◇ Approval');
  expect(markup).toContain('≡ Queued');
  expect(markup).toContain('⌕ Reviewing');
});
it('makes snapshot freshness explicit and disables contextual actions while disconnected', () => {
  const markup = renderToStaticMarkup(
    createElement(PixelOffice, {
      agents,
      selectedAgent: 'codex-1',
      onSelect: () => {},
      onAssign: () => {},
      transport: 'disconnected',
    }),
  );
  expect(markup).toContain('showing the last saved snapshot');
  expect(markup).toContain('disabled="">Assign a task');
});

it('treats initial loading and initial connection failure as unknown counts, not an empty office', () => {
  for (const transport of ['loading', 'unavailable'] as const) {
    const markup = renderToStaticMarkup(
      createElement(PixelOffice, {
        agents: [],
        selectedAgent: 'missing',
        onSelect: () => {},
        transport,
      }),
    );
    expect(markup).toContain('Loading profiles…');
    expect(markup).toContain('Waiting for the task queue…');
    expect(markup).not.toContain('No agent profiles yet.');
    expect(markup).not.toContain('No queued tasks.');
    expect(markup).not.toContain('Your office is ready for company.');
  }
});
