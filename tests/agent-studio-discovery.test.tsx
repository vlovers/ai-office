import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../src/shared/types.js';
import { AgentStudio } from '../src/web/agent-studio.js';

const render = (profiles: AgentProfile[]) =>
  renderToStaticMarkup(
    <AgentStudio
      profiles={profiles}
      api={async () => undefined as never}
      refresh={async () => {}}
      select={() => {}}
    />,
  );

describe('Agent Studio discovery', () => {
  it('explains the empty workspace without suggesting hidden profiles', () => {
    const html = render([]);
    expect(html).toContain('0 of 0 profiles shown');
    expect(html).toContain('No profiles yet. Create an agent to get started.');
    expect(html).toContain('Find profiles');
  });
});
