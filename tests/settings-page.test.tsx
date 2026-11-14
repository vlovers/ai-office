import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Dashboard } from '../src/shared/types.js';
import { SettingsPage } from '../src/web/settings-page.js';

const snapshot = {
  connection: {
    mode: 'local-cli-chatgpt',
    status: 'available',
    message: 'Local provider available',
  },
} as Dashboard;

function render(transportConnected: boolean, dashboard?: Dashboard) {
  return renderToStaticMarkup(
    <SettingsPage
      dashboard={dashboard}
      busy={false}
      agentBusy={false}
      transportConnected={transportConnected}
      onChangeMode={() => {}}
      onRefreshConnection={() => {}}
      onRegisterRepository={() => {}}
    />,
  );
}

describe('Settings connection truthfulness', () => {
  it('does not label a stale provider snapshot as available when offline', () => {
    const html = render(false, snapshot);
    expect(html).toContain('Server disconnected');
    expect(html).toContain('Last known provider state: Local provider available');
    expect(html).not.toContain('data-testid="codex-connection-status">Available');
    expect(html).toMatch(/id="authentication-mode"[^>]*disabled/);
    expect(html).toMatch(/class="secondary" disabled="">Register/);
    expect(html).toContain('Refresh connection');
  });

  it('does not fabricate a provider state before the first snapshot', () => {
    const html = render(false);
    expect(html).toContain('Provider status unavailable until the server reconnects.');
    expect(html).not.toContain('Checking connection…');
  });

  it('preserves live provider status while connected', () => {
    const html = render(true, snapshot);
    expect(html).toContain('data-testid="codex-connection-status">Available');
    expect(html).toContain('Local provider available');
    expect(html).not.toContain('Last known provider state:');
  });
});
