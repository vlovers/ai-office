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
  expect(markup.match(/class="office-room"/g)).toHaveLength(1);
  expect(markup.match(/role="button"/g)).toHaveLength(2);
  expect(markup.match(/tabindex="0"/g)).toHaveLength(2);
  expect(markup).toContain('data-agent-id="codex-1" data-state="thinking"');
  expect(markup).toContain('data-agent-id="codex-2" data-state="error"');
  expect(markup).toContain('aria-label="Select Codex 01 workstation" aria-pressed="true"');
  expect(markup).toContain('aria-label="Select Codex 02 workstation" aria-pressed="false"');
  expect(markup).toContain('Thinking · SDK reasoning item. Read only.');
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
