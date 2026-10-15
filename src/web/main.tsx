import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Dashboard, Task, AuthMode } from '../shared/types.js';
import { PixelBot, PixelOffice } from './pixel-art.js';
import './styles.css';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data as T;
}
const activeStates = ['running', 'stopping'];
function App() {
  const [crt, setCrt] = useState(() => {
    try {
      return localStorage.getItem('ai-office-crt') === 'on';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ai-office-crt', crt ? 'on' : 'off');
    } catch {
      /* Storage is optional. */
    }
  }, [crt]);
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [selected, setSelected] = useState<string>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState('Connecting');
  const [repositoryId, setRepositoryId] = useState('');
  const [resumeSessionId, setResumeSessionId] = useState('');
  const refresh = async () => {
    try {
      const data = await api<Dashboard>('/dashboard');
      setDashboard(data);
      setConnection('Local server connected');
    } catch (e) {
      setConnection('Server disconnected');
      throw e;
    }
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e.message)));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!repositoryId && dashboard?.repositories[0]) setRepositoryId(dashboard.repositories[0].id);
  }, [dashboard, repositoryId]);
  useEffect(() => {
    setEvents([]);
    if (!selected) return;
    const stream = new EventSource(`/api/tasks/${selected}/stream`);
    stream.onopen = () => setConnection('Live events connected');
    stream.onerror = () => setConnection('Reconnecting to live events…');
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      setEvents((previous) =>
        previous.some((item) => item.id === event.id) ? previous : [...previous, event].slice(-500),
      );
      if (event.kind === 'state') void refresh().catch(() => {});
    };
    return () => stream.close();
  }, [selected]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const task = dashboard?.tasks.find((item) => item.id === selected);
  const repository = dashboard?.repositories.find((item) => item.id === task?.repositoryId);
  const session = dashboard?.sessions.find((item) => item.id === task?.sessionId);
  const agentBusy = !dashboard || dashboard.agent.state !== 'idle';
  const selectedRepository = dashboard?.repositories.find((item) => item.id === repositoryId);
  return (
    <div className={`shell ${crt ? 'crt-enabled' : ''}`}>
      <a className="skip-link" href="#overview">
        Skip to mission control
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="#overview">
          <PixelBot />
          <span>
            AI OFFICE<small>PHOSPHOR OS / PHASE 1.3</small>
          </span>
        </a>
        <div className="nav-label">// MISSION DIRECTORY</div>
        <nav aria-label="Dashboard sections">
          <a className="nav-item active" href="#overview">
            <span aria-hidden="true">⌂</span>Dashboard<span className="nav-count">01</span>
          </a>
          <a className="nav-item" href="#agent">
            <span aria-hidden="true">♙</span>Agent<span className="nav-count">01</span>
          </a>
          <a className="nav-item" href="#task-history">
            <span aria-hidden="true">▤</span>Task history
            <span className="nav-count">{dashboard?.tasks.length ?? 0}</span>
          </a>
          <a className="nav-item" href="#task-workspace">
            <span aria-hidden="true">▣</span>Session terminal
          </a>
          <a className="nav-item" href="#compose">
            <span aria-hidden="true">＋</span>New task
          </a>
        </nav>
        <div className="sidebar-section">
          <div className="nav-label">
            REPOSITORIES <span>{dashboard?.repositories.length ?? 0}</span>
          </div>
          {dashboard?.repositories.map((repo) => (
            <button
              className={`repo-link ${repositoryId === repo.id ? 'chosen' : ''}`}
              key={repo.id}
              aria-pressed={repositoryId === repo.id}
              onClick={() => {
                setRepositoryId(repo.id);
                setResumeSessionId('');
              }}
              title={repo.path}
            >
              <span aria-hidden="true">⌑</span>
              <span>
                {repo.name}
                <small>{repo.path}</small>
              </span>
            </button>
          ))}
          {!dashboard?.repositories.length && (
            <p className="sidebar-empty">
              No worktree connected.
              <br />
              <a href="#repositories">Register a repository →</a>
            </p>
          )}
        </div>
        <div className="sidebar-art" aria-hidden="true">
          <PixelBot />
          <span>
            GOOD CODE.
            <br />
            HUMAN CONTROL.
          </span>
        </div>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          Local-only server<small>127.0.0.1 / READ ONLY</small>
        </div>
      </aside>
      <main id="overview" tabIndex={-1}>
        <header className="topbar">
          <div className="workspace-chip">
            <span className="eyebrow">REGISTERED WORKTREE</span>
            <strong>{selectedRepository?.name ?? 'No repository selected'}</strong>
          </div>
          <span className="connection" role="status">
            <span
              className={
                connection.includes('disconnected') || connection.includes('Reconnecting')
                  ? 'status-dot amber'
                  : 'status-dot'
              }
            />
            {connection}
          </span>
          <button
            className="crt-toggle secondary"
            aria-pressed={crt}
            onClick={() => setCrt(!crt)}
            title="Static scanlines and phosphor glow. Reduced-motion settings disable the effect."
          >
            CRT effects: {crt ? 'on' : 'off'}
          </button>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">AI OFFICE / PHOSPHOR OS</div>
              <h1>
                Mission control<span>_</span>
              </h1>
              <p>One Codex agent. Read-only review. You have the controls.</p>
            </div>
            <a className="button-link" href="#compose">
              ＋ New task
            </a>
          </div>
          {error && (
            <div role="alert" className="error-banner">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          <div className="mission-grid">
            <div className="mission-board">
              <section className="office-scene" aria-label="Pixel office illustration">
                <div className="scene-label">
                  <span>WORKSPACE / 01</span>
                  <span>READ-ONLY STATION</span>
                </div>
                <PixelOffice />
                <div className="scene-caption">
                  <span>
                    <span className="status-dot" />
                    CODEX / {dashboard?.agent.state ?? 'connecting'}
                  </span>
                  <span>One workstation. Room to think.</span>
                </div>
              </section>
              <div className="stats" aria-label="Workspace statistics">
                <div>
                  <span>AGENT SLOTS</span>
                  <strong>
                    {dashboard ? '01' : '—'}
                    <small>Codex only</small>
                  </strong>
                </div>
                <div>
                  <span>IN PROGRESS</span>
                  <strong>
                    {dashboard?.tasks.filter((t) => activeStates.includes(t.state)).length ?? 0}
                    <small>active task</small>
                  </strong>
                </div>
                <div>
                  <span>COMPLETED</span>
                  <strong>
                    {dashboard?.tasks.filter((t) => t.state === 'completed').length ?? 0}
                    <small>saved results</small>
                  </strong>
                </div>
                <div>
                  <span>ACCESS</span>
                  <strong className="environment">
                    R/O<small>Repository scoped</small>
                  </strong>
                </div>
              </div>
              <section className="panel history" id="task-history">
                <div className="panel-heading">
                  <h2>Task history</h2>
                  <span className="subtle">{dashboard?.tasks.length ?? 0} tasks</span>
                </div>
                {!dashboard?.tasks.length ? (
                  <div className="empty-state">
                    <div>☷</div>
                    <h3>A clean slate.</h3>
                    <p>
                      Your tasks and their results will appear here.
                      <br />
                      Create your first task to get started.
                    </p>
                  </div>
                ) : (
                  <div className="task-list">
                    {dashboard.tasks.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={selected === item.id}
                        className={`task-row ${selected === item.id ? 'selected' : ''}`}
                        onClick={() => {
                          setSelected(item.id);
                          setResumeSessionId('');
                        }}
                      >
                        <span className={`task-indicator ${item.state}`} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {dashboard.repositories.find((r) => r.id === item.repositoryId)?.name} ·{' '}
                            {new Date(item.createdAt).toLocaleString()}
                          </small>
                        </span>
                        <span className={`badge ${item.state}`}>{item.state}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section className="panel output" id="task-workspace">
                <div className="panel-heading">
                  <h2>
                    Task workspace {task && <span className="output-title">/ {task.title}</span>}
                  </h2>
                  <span className="subtle">LIVE OUTPUT</span>
                </div>
                {!task ? (
                  <div className="output-empty">
                    <span>↳</span> Select a task to follow its progress and review the result.
                  </div>
                ) : (
                  <>
                    <div className="task-toolbar">
                      <span>
                        <span className={`badge ${task.state}`}>{task.state}</span>{' '}
                        {repository?.name}
                      </span>
                      {task.state === 'queued' && (
                        <div className="start-controls">
                          <select
                            aria-label="Session"
                            value={resumeSessionId}
                            onChange={(e) => setResumeSessionId(e.target.value)}
                          >
                            <option value="">New Codex session</option>
                            {dashboard?.sessions
                              .filter(
                                (s) =>
                                  s.repositoryId === task.repositoryId &&
                                  s.threadId &&
                                  s.authMode === dashboard.connection.mode,
                              )
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  Resume {s.threadId?.slice(0, 12)}…
                                </option>
                              ))}
                          </select>
                          <button
                            disabled={busy || agentBusy || !dashboard?.ready}
                            onClick={() =>
                              void act(async () => {
                                await api(
                                  `/tasks/${task.id}/start`,
                                  resumeSessionId ? { resumeSessionId } : {},
                                );
                              })
                            }
                          >
                            ▶ Start task
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="task-prompt">{task.prompt}</p>
                    {session?.threadId && (
                      <p className="thread-id">
                        Thread <code>{session.threadId}</code>
                        <span className="session-mode">
                          {session.authMode === 'local-cli-chatgpt'
                            ? 'ChatGPT login'
                            : session.authMode === 'api-key'
                              ? 'API key'
                              : 'Legacy session'}
                          {session.model ? ` · ${session.model}` : ''}
                        </span>
                      </p>
                    )}
                    <div
                      className="event-console"
                      aria-label="Agent event log"
                      role="log"
                      tabIndex={0}
                    >
                      {events.length ? (
                        events.map((item) => (
                          <div className="event-line" key={item.id}>
                            <time>{new Date(item.at).toLocaleTimeString()}</time>
                            <span className="event-kind">{item.kind}</span>
                            <pre>{item.message}</pre>
                          </div>
                        ))
                      ) : (
                        <span className="console-placeholder">
                          Ready. Start this task to open a Codex session.
                        </span>
                      )}
                    </div>
                    {task.error && (
                      <p className="task-error" role="alert">
                        {task.error}
                      </p>
                    )}
                    {task.result && (
                      <div className="result">
                        <h3>Final result</h3>
                        <pre>{task.result}</pre>
                      </div>
                    )}
                    {!['queued', 'running', 'stopping'].includes(task.state) && (
                      <div className="file-summary">
                        <h3>
                          Changed-file summary <span>{task.changedFiles.length}</span>
                        </h3>
                        <p>
                          Git worktree status at finish, including pre-existing changes. The agent
                          has read-only access.
                        </p>
                        {task.summaryError ? (
                          <p role="alert">Summary unavailable: {task.summaryError}</p>
                        ) : task.changedFiles.length ? (
                          <ul>
                            {task.changedFiles.map((file) => (
                              <li key={file.path}>
                                <code>{file.status}</code> {file.path}
                                {task.baselineFiles.some((before) => before.path === file.path) && (
                                  <small> · present before task</small>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>No changed files in the worktree.</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
              <section className="panel compose" id="compose">
                <div className="panel-heading">
                  <h2>Create a task</h2>
                  <span className="step">02</span>
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const data = new FormData(form);
                    void act(async () => {
                      const created = await api<Task>('/tasks', {
                        repositoryId,
                        agentId: 'codex-1',
                        title: data.get('title'),
                        prompt: data.get('prompt'),
                      });
                      setSelected(created.id);
                      form.reset();
                    });
                  }}
                >
                  <label htmlFor="repository">Repository</label>
                  <select
                    id="repository"
                    required
                    value={repositoryId}
                    onChange={(event) => {
                      setRepositoryId(event.target.value);
                      setResumeSessionId('');
                    }}
                  >
                    <option value="" disabled>
                      Select a repository
                    </option>
                    {dashboard?.repositories.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="title">Task title</label>
                  <input
                    id="title"
                    name="title"
                    required
                    maxLength={160}
                    placeholder="Review the project structure"
                  />
                  <label htmlFor="prompt">What should the agent work on?</label>
                  <textarea
                    id="prompt"
                    name="prompt"
                    required
                    maxLength={16000}
                    rows={5}
                    placeholder="Explore the codebase, explain how it fits together, and suggest the next improvement…"
                  />
                  <div className="compose-footer">
                    <span>
                      <span className="tiny-avatar">⌘</span> Assigned to Codex 01
                    </span>
                    <button disabled={busy || !repositoryId}>
                      Create task <span>→</span>
                    </button>
                  </div>
                </form>
                <p className="read-only-note">
                  Read-only review. Changes are proposed for manual review. Approval-required
                  actions are blocked.
                </p>
              </section>
            </div>
            <aside className="inspector" aria-label="Agent and connection inspector">
              <section className="panel agent-panel" id="agent">
                <div className="panel-heading">
                  <h2>Your agent</h2>
                  <span className="subtle">01 / 01</span>
                </div>
                <div className="agent-info">
                  <div className="agent-avatar">
                    <PixelBot />
                  </div>
                  <div>
                    <h3>
                      Codex 01{' '}
                      <span className={`badge ${dashboard?.agent.state ?? ''}`}>
                        {dashboard ? dashboard.agent.state : 'connecting'}
                      </span>
                    </h3>
                    <p>
                      OpenAI <span>·</span> Coding & repository review
                    </p>
                  </div>
                </div>
                <div className="agent-detail">
                  <span>Access mode</span>
                  <strong>Read only</strong>
                </div>
                <div className="agent-detail">
                  <span>Workspace</span>
                  <strong>
                    {dashboard?.repositories.find(
                      (r) =>
                        r.id ===
                        dashboard.tasks.find((t) => t.id === dashboard.agent.taskId)?.repositoryId,
                    )?.name ?? 'Awaiting a task'}
                  </strong>
                </div>
                <div className="agent-detail">
                  <span>Saved sessions</span>
                  <strong>{dashboard?.sessions.length ?? 0}</strong>
                </div>
                <div className="agent-note">
                  <span>↳</span>
                  <p>{dashboard?.readinessMessage ?? 'Connecting to the local backend…'}</p>
                </div>
                {agentBusy && dashboard?.agent.taskId && (
                  <button
                    className="stop-button"
                    disabled={
                      busy || dashboard.agent.state === 'stopping' || !dashboard.agent.canStop
                    }
                    onClick={() =>
                      void act(async () => {
                        await api(`/tasks/${dashboard.agent.taskId}/stop`, {});
                      })
                    }
                  >
                    ■ Stop agent
                  </button>
                )}
              </section>
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
                        : dashboard?.connection.status === 'authentication-required'
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
                      onChange={(event) => {
                        const mode = event.target.value as AuthMode;
                        void act(async () => {
                          await api('/connection', { mode });
                          setResumeSessionId('');
                        });
                      }}
                    >
                      <option value="local-cli-chatgpt">Local ChatGPT login (preferred)</option>
                      <option value="api-key">API key (separate billing)</option>
                    </select>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy || agentBusy}
                    onClick={() =>
                      void act(async () => {
                        await api('/connection/refresh', {});
                      })
                    }
                  >
                    Refresh connection
                  </button>
                </div>
                <p className="connection-message">
                  {dashboard?.connection.message ?? 'Checking the local backend connection…'}
                </p>
                <p className="field-hint">
                  No credentials are entered in this dashboard. Local login never falls back to API
                  billing.
                </p>
              </section>
              <section className="panel repository-panel" id="repositories">
                <div className="panel-heading">
                  <h2>Connect a repository</h2>
                  <span className="step">01</span>
                </div>
                <p className="panel-description">
                  Choose an existing local Git worktree. Your files stay on your machine; task
                  context is sent to your AI provider.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const data = new FormData(form);
                    void act(async () => {
                      const repo = await api<{ id: string }>('/repositories', {
                        path: data.get('path'),
                      });
                      setRepositoryId(repo.id);
                      setResumeSessionId('');
                      form.reset();
                    });
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
            </aside>
          </div>
          <footer>
            <span>
              ▣ PHOSPHOR OS <span> / </span> HUMAN-DIRECTED AI
            </span>
            <span>LOCAL FIRST · ONE AGENT AT A TIME</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
