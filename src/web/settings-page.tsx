import type { AuthMode, Dashboard } from '../shared/types.js';

export function SettingsPage({
  dashboard,
  busy,
  agentBusy,
  onChangeMode,
  onRefreshConnection,
  onRegisterRepository,
}: {
  dashboard?: Dashboard;
  busy: boolean;
  agentBusy: boolean;
  onChangeMode: (mode: AuthMode) => void;
  onRefreshConnection: () => void;
  onRegisterRepository: (path: string, form: HTMLFormElement) => void;
}) {
  return (
    <div className="settings-destination">
      <div className="destination-intro">
        <h2>Workspace settings</h2>
        <p>Manage your local connection and trusted repository roots.</p>
      </div>
      <section className="panel connection-panel" aria-label="Codex connection">
        <div className="panel-heading">
          <h2>Codex connection</h2>
          <span
            className={`badge ${dashboard?.connection.status === 'available' ? 'completed' : 'failed'}`}
            role="status"
            data-testid="codex-connection-status"
          >
            {!dashboard
              ? 'Checking connection…'
              : dashboard.connection.status === 'available'
                ? 'Available'
                : dashboard.connection.status === 'authentication-required'
                  ? 'Authentication required'
                  : 'Connection error'}
          </span>
        </div>
        <div className="connection-controls">
          <div>
            <label htmlFor="authentication-mode">Authentication mode</label>
            <select
              id="authentication-mode"
              value={dashboard?.connection.mode ?? 'local-cli-chatgpt'}
              disabled={busy || agentBusy}
              onChange={(event) => onChangeMode(event.target.value as AuthMode)}
            >
              <option value="local-cli-chatgpt">Local ChatGPT login (preferred)</option>
              <option value="api-key">API key (separate billing)</option>
            </select>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy || agentBusy}
            onClick={onRefreshConnection}
          >
            Refresh connection
          </button>
        </div>
        <p className="connection-message">
          {dashboard?.connection.message ?? 'Checking the local backend connection…'}
        </p>
        <p className="field-hint">
          No credentials are entered in this dashboard. Local login never falls back to API billing.
        </p>
      </section>
      <section className="panel repository-panel" id="repositories">
        <div className="panel-heading">
          <h2>Connect a repository</h2>
          <span className="step">01</span>
        </div>
        <p className="panel-description">
          Choose an existing local Git worktree. Your files stay on your machine; task context is
          sent to your AI provider.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            onRegisterRepository(String(data.get('path') ?? ''), form);
          }}
        >
          <label htmlFor="path">Absolute repository path</label>
          <div className="input-row">
            <input
              id="path"
              name="path"
              required
              placeholder="/Users/you/projects/example"
              autoComplete="off"
            />
            <button className="secondary" disabled={busy}>
              Register <span>↗</span>
            </button>
          </div>
          <p className="field-hint">
            Git worktree roots only. Estima and Pixel Office are excluded.
          </p>
        </form>
      </section>
    </div>
  );
}
