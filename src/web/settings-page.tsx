import { useEffect, useState } from 'react';
import { WorkspaceIcon, type WorkspaceIconName } from './workspace-icon.js';
import type { AuthMode, Dashboard } from '../shared/types.js';

const settingsSections = [
  'General',
  'Repositories',
  'Execution',
  'Policies',
  'Integrations',
  'Appearance',
  'Security',
] as const;
type SettingsSection = (typeof settingsSections)[number];
const sectionIcons: WorkspaceIconName[] = [
  'settings',
  'repository',
  'execution',
  'security',
  'workflows',
  'overview',
  'security',
];
export function settingsSectionFromHash(hash: string): SettingsSection {
  if (hash === '#repositories') return 'Repositories';
  if (hash === '#connection') return 'Integrations';
  return (
    settingsSections.find((section) => hash === `#settings/${section.toLowerCase()}`) ?? 'General'
  );
}

export function SettingsPage({
  dashboard,
  busy,
  agentBusy,
  transportConnected,
  onChangeMode,
  onRefreshConnection,
  onRegisterRepository,
}: {
  dashboard?: Dashboard;
  busy: boolean;
  agentBusy: boolean;
  transportConnected: boolean;
  onChangeMode: (mode: AuthMode) => void;
  onRefreshConnection: () => void;
  onRegisterRepository: (path: string, form: HTMLFormElement) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(() =>
    settingsSectionFromHash(typeof window === 'undefined' ? '' : window.location.hash),
  );
  useEffect(() => {
    const sync = () => setSection(settingsSectionFromHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  let connectionStatus = 'Server disconnected';
  if (transportConnected && !dashboard) connectionStatus = 'Checking connection…';
  if (transportConnected && dashboard) {
    if (dashboard.connection.status === 'available') connectionStatus = 'Available';
    else if (dashboard.connection.status === 'authentication-required') {
      connectionStatus = 'Authentication required';
    } else connectionStatus = 'Connection error';
  }
  const connectionBadgeClass =
    transportConnected && dashboard?.connection.status === 'available' ? 'completed' : 'failed';
  let connectionMessage = 'Checking the local backend connection…';
  if (!transportConnected) {
    connectionMessage = dashboard
      ? `Last known provider state: ${dashboard.connection.message}`
      : 'Provider status unavailable until the server reconnects.';
  } else if (dashboard) {
    connectionMessage = dashboard.connection.message;
  }
  return (
    <div className="settings-destination">
      <nav className="settings-subnav" aria-label="Settings sections">
        {settingsSections.map((item, index) => (
          <a
            key={item}
            href={item === 'General' ? '#settings' : `#settings/${item.toLowerCase()}`}
            aria-current={section === item ? 'page' : undefined}
            onClick={() => {
              setSection(item);
              requestAnimationFrame(() =>
                document.getElementById('settings-content')?.focus({ preventScroll: true }),
              );
            }}
          >
            <WorkspaceIcon name={sectionIcons[index]!} />
            {item}
          </a>
        ))}
      </nav>
      <div className="settings-body" id="settings-content" tabIndex={-1}>
        <section className="detail-card settings-summary">
          <h2>{section}</h2>
          <p>
            {section === 'General'
              ? 'Local workspace configuration and trusted repository access.'
              : `Workspace ${section.toLowerCase()} and availability.`}
          </p>
        </section>
        {!transportConnected && (
          <p role="status" className="overview-transport-warning">
            Server connection unavailable. Settings show the last received snapshot; reconnect
            before changing authentication or registering repositories.
          </p>
        )}
        <section
          className="panel connection-panel"
          aria-label="Codex connection"
          hidden={!['General', 'Integrations'].includes(section)}
        >
          <div className="panel-heading">
            <h2>Codex connection</h2>
            <span
              className={`badge ${connectionBadgeClass}`}
              role="status"
              data-testid="codex-connection-status"
            >
              {connectionStatus}
            </span>
          </div>
          <div className="connection-controls">
            <div>
              <label htmlFor="authentication-mode">Authentication mode</label>
              <select
                id="authentication-mode"
                value={dashboard?.connection.mode ?? 'local-cli-chatgpt'}
                disabled={!transportConnected || !dashboard || busy || agentBusy}
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
          <p className="connection-message">{connectionMessage}</p>
          <p className="field-hint">
            No credentials are entered in this dashboard. Local login never falls back to API
            billing.
          </p>
        </section>
        <section
          className="panel repository-panel"
          id="repositories"
          hidden={!['General', 'Repositories'].includes(section)}
        >
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
              <button className="secondary" disabled={!transportConnected || busy}>
                Register <span>↗</span>
              </button>
            </div>
            <p className="field-hint">
              Git worktree roots only. Estima and Pixel Office are excluded.
            </p>
          </form>
        </section>
        {['General', 'Repositories'].includes(section) && !!dashboard?.repositories?.length && (
          <section className="detail-card">
            <h3>Registered repositories</h3>
            <ul className="registered-repositories">
              {dashboard.repositories.map((repo) => (
                <li key={repo.id}>
                  <WorkspaceIcon name="repository" />
                  <div>
                    <strong>{repo.name}</strong>
                    <code>{repo.path}</code>
                  </div>
                  <span className="badge completed">Registered</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {section === 'Execution' && (
          <section className="detail-card">
            <h3>Execution policy</h3>
            <dl className="metadata-list">
              <div>
                <dt>Worker capacity</dt>
                <dd>{dashboard?.concurrency ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Default access</dt>
                <dd>Read only</dd>
              </div>
              <div>
                <dt>Isolated writes</dt>
                <dd>Explicit confirmation per task</dd>
              </div>
            </dl>
            <p>
              Task configuration is pinned when submitted. Agent execution preferences are managed
              in <a href="#agents">Agents</a>.
            </p>
            <p className="unavailable-copy">
              Balanced / Economy modes, automatic retries and request budgets are unavailable. No
              editable backend preferences exist for these controls.
            </p>
          </section>
        )}
        {section === 'Policies' && (
          <section className="detail-card">
            <h3>Review and approval</h3>
            <p>
              Isolated worktree changes require a manual keep or reject decision in the task Review
              tab. Workflow approval checkpoints remain explicit.
            </p>
            <p className="unavailable-copy">
              Automatic review, risk defaults and scope expansion settings are unavailable.
            </p>
          </section>
        )}
        {section === 'Appearance' && (
          <section className="detail-card">
            <h3>Display preferences</h3>
            <p>
              The Appearance menu in the topbar controls scene motion and optional CRT effects.
              These preferences are saved in this browser. System reduced-motion settings take
              priority.
            </p>
            <p className="unavailable-copy">
              Shared appearance preferences are unavailable; they are not stored by the backend.
            </p>
          </section>
        )}
        {section === 'Security' && (
          <section className="detail-card">
            <h3>Local execution boundaries</h3>
            <p>
              The dashboard connects to a local backend. Read-only tasks and isolated worktree
              writes retain existing sandbox policies. Credentials are never entered here.
            </p>
            <p>
              Authentication mode can be changed under{' '}
              <a href="#settings/integrations">Integrations</a> when no agents are busy.
            </p>
            <p className="unavailable-copy">Remote delivery is not activated by this interface.</p>
          </section>
        )}
      </div>
      <aside className="settings-limits detail-card">
        <h3>
          <WorkspaceIcon name="security" />
          Budget &amp; limits
        </h3>
        <p>Execution limits and review requirements for this workspace.</p>
        <dl className="metadata-list">
          <div>
            <dt>Concurrent workers</dt>
            <dd>{dashboard?.concurrency ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Daily request budget</dt>
            <dd>Unavailable</dd>
          </div>
          <div>
            <dt>Risk default</dt>
            <dd>Not recorded</dd>
          </div>
        </dl>
        <p className="unavailable-copy">
          Budget, notification and automatic approval preferences are not supported by the backend.
        </p>
      </aside>
    </div>
  );
}
