import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Dashboard, Task, AuthMode, AgentId } from '../shared/types.js';
import { AgentStudio } from './agent-studio.js';
import { ReviewCenter } from './review-center.js';
import { PixelBot, PixelOffice } from './pixel-art.js';
import { sceneStatus, workstationTask } from './scene-state.js';
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
  const [motion, setMotion] = useState(() => {
    try {
      return localStorage.getItem('ai-office-motion') !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ai-office-motion', motion ? 'on' : 'off');
    } catch {
      /* Optional preference. */
    }
  }, [motion]);
  const [view, setView] = useState<'mission' | 'focus'>('mission');
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [selected, setSelected] = useState<string>();
  const [eventHistory, setEventHistory] = useState<Record<string, AgentEvent[]>>({});
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('codex-1');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingStops, setPendingStops] = useState<string[]>([]);
  const [connection, setConnection] = useState('Connecting');
  const [repositoryId, setRepositoryId] = useState('');
  const [resumeSessionId, setResumeSessionId] = useState('');
  const [executionMode, setExecutionMode] = useState('read-only');
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
  const streamIds = [
    ...new Set(
      [selected, ...(dashboard?.agents.map((agent) => agent.taskId) ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ]
    .sort()
    .join(',');
  useEffect(() => {
    const ids = streamIds ? streamIds.split(',') : [];
    setEventHistory((previous) => Object.fromEntries(ids.map((id) => [id, previous[id] ?? []])));
    const streams = ids.map((id) => {
      const stream = new EventSource(`/api/tasks/${id}/stream`);
      stream.onopen = () => setConnection('Live events connected');
      stream.onerror = () => setConnection('Reconnecting to live events…');
      stream.onmessage = (message) => {
        const event = JSON.parse(message.data) as AgentEvent;
        setEventHistory((previous) => {
          const events = previous[id] ?? [];
          return {
            ...previous,
            [id]: events.some((item) => item.id === event.id)
              ? events
              : [...events, event].slice(-500),
          };
        });
        if (event.kind === 'state') void refresh().catch(() => {});
      };
      return stream;
    });
    return () => streams.forEach((stream) => stream.close());
  }, [streamIds]);
  const events = selected ? (eventHistory[selected] ?? []) : [];
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
  const stopTask = async (taskId: string) => {
    setPendingStops((previous) => [...previous, taskId]);
    setError('');
    try {
      await api(`/tasks/${taskId}/stop`, {});
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingStops((previous) => previous.filter((id) => id !== taskId));
    }
  };
  const task = dashboard?.tasks.find((item) => item.id === selected);
  const repository = dashboard?.repositories.find((item) => item.id === task?.repositoryId);
  const session = dashboard?.sessions.find((item) => item.id === task?.sessionId);
  const taskConfiguration = task?.configuration ?? session?.configuration;
  const agent = dashboard?.agents.find((item) => item.id === selectedAgent);
  const selectedProfile = dashboard?.profiles?.find((profile) => profile.id === selectedAgent);
  const assignable =
    dashboard?.agents.filter(
      (slot) => !dashboard.profiles?.find((profile) => profile.id === slot.id)?.archived,
    ) ?? [];
  const canAssign = assignable.some((slot) => slot.id === selectedAgent);
  useEffect(() => {
    if (selectedProfile?.maximumMode !== 'write') setExecutionMode('read-only');
  }, [selectedProfile?.id, selectedProfile?.maximumMode]);
  const agentBusy = !dashboard || dashboard.agents.some((item) => item.taskId !== null);
  const selectedBusy = Boolean(agent?.taskId);
  const queued = dashboard?.queue.find((entry) => entry.taskId === selected);
  const selectedRepository = dashboard?.repositories.find((item) => item.id === repositoryId);
  const scene = sceneStatus(
    dashboard,
    task,
    Object.values(eventHistory).flat(),
    connection.includes('disconnected'),
    selectedAgent,
  );
  const stationTask = workstationTask(dashboard, selected, selectedAgent);
  const showSection = (id: string) => {
    const origin = document.activeElement;
    requestAnimationFrame(() => {
      // A later keyboard/pointer action takes precedence over this deferred navigation.
      if (document.activeElement !== origin) return;
      const section = document.getElementById(id);
      section?.focus();
      section?.scrollIntoView({ block: 'start' });
    });
  };
  const selectStation = (agentId: AgentId) => {
    setSelectedAgent(agentId);
    const stationTask = workstationTask(dashboard, selected, agentId);
    setSelected(stationTask?.id);
    setResumeSessionId('');
    // Inspect in place; Focus Mode remains an explicit choice.
    if (!stationTask) showSection('agent');
  };
  const stopControl = selectedBusy && agent?.taskId && (
    <button
      className="stop-button"
      disabled={pendingStops.includes(agent.taskId) || agent.state === 'stopping' || !agent.canStop}
      onClick={() => void stopTask(agent.taskId!)}
    >
      ■ Stop agent
    </button>
  );
  return (
    <div
      className={`shell ${crt ? 'crt-enabled' : ''} ${motion ? 'scene-motion' : ''} ${view === 'focus' ? 'focus-mode' : ''}`}
    >
      <a className="skip-link" href="#overview">
        Skip to mission control
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="#overview" onClick={() => setView('mission')}>
          <PixelBot />
          <span>
            AI OFFICE<small>PHOSPHOR OS / Agent Studio</small>
          </span>
        </a>
        <div className="nav-label">// MISSION DIRECTORY</div>
        <nav aria-label="Dashboard sections">
          <a
            className={`nav-item ${view === 'mission' ? 'active' : ''}`}
            href="#overview"
            onClick={() => setView('mission')}
          >
            <span aria-hidden="true">⌂</span>Dashboard<span className="nav-count">01</span>
          </a>
          <a className="nav-item" href="#agent" onClick={() => setView('mission')}>
            <span aria-hidden="true">♙</span>Agents
            <span className="nav-count">{dashboard?.agents.length ?? 0}</span>
          </a>
          <a className="nav-item" href="#agent-studio" onClick={() => setView('mission')}>
            Agent Studio
          </a>
          <a className="nav-item" href="#task-history" onClick={() => setView('mission')}>
            <span aria-hidden="true">▤</span>Task history
            <span className="nav-count">{dashboard?.tasks.length ?? 0}</span>
          </a>
          <a className="nav-item" href="#task-workspace">
            <span aria-hidden="true">▣</span>Session terminal
          </a>
          <a className="nav-item" href="#compose" onClick={() => setView('mission')}>
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
          Local-only server<small>127.0.0.1 / LOCAL</small>
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
            className="motion-toggle secondary"
            aria-pressed={motion}
            onClick={() => setMotion(!motion)}
            title="Animate the office. Reduced motion overrides this preference; CRT glow is controlled separately."
          >
            Scene motion: {motion ? 'on' : 'off'}
          </button>
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
                {view === 'focus' ? 'Focus mode' : 'Mission control'}
                <span>_</span>
              </h1>
              <p>Your agent profiles. Two workers. Isolated coding and repository review.</p>
            </div>
            <a
              className="button-link"
              href="#compose"
              onClick={() => {
                setView('mission');
                showSection('compose');
              }}
            >
              ＋ New task
            </a>
          </div>
          <div className="view-switch" role="group" aria-label="Workspace view">
            <button
              className="secondary"
              aria-pressed={view === 'mission'}
              onClick={() => setView('mission')}
            >
              Mission Control
            </button>
            <button
              className="secondary"
              aria-pressed={view === 'focus'}
              disabled={!stationTask}
              onClick={() => {
                if (stationTask) {
                  setSelected(stationTask.id);
                  setResumeSessionId('');
                  setView('focus');
                  showSection('task-workspace');
                }
              }}
            >
              Focus Mode
            </button>
            <span>
              {view === 'focus'
                ? 'Session output first. Stop and results stay within reach.'
                : 'Overview / saved profiles · two worker capacity'}
            </span>
          </div>
          {dashboard && !dashboard.repositories.length && (
            <section className="onboarding" aria-label="Get started">
              <span className="setup-index" aria-hidden="true">
                01 →
              </span>
              <div>
                <h2>Connect your first worktree</h2>
                <p>
                  Register a local Git repository, create a review task, then start a read-only
                  Codex session. Your files stay unchanged.
                </p>
                <ol>
                  <li>Register a repository</li>
                  <li>Describe a task</li>
                  <li>Start the review</li>
                </ol>
              </div>
              <a
                className="button-link"
                href="#repositories"
                onClick={() => {
                  setView('mission');
                  requestAnimationFrame(() => document.getElementById('path')?.focus());
                }}
              >
                Register local worktree
              </a>
            </section>
          )}
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
              <section className="office-scene" aria-label="Shared Codex office">
                <div className="scene-label">
                  <span>AI OFFICE / SHARED WORKSPACE</span>
                  <span>TASK-SCOPED ACCESS</span>
                </div>
                <PixelOffice
                  agents={(dashboard?.agents ?? [])
                    .filter(
                      (slot) =>
                        !dashboard?.profiles?.find((profile) => profile.id === slot.id)?.archived ||
                        slot.taskId,
                    )
                    .map((slot) => ({
                      id: slot.id,
                      name: slot.name,
                      role: dashboard?.profiles?.find((profile) => profile.id === slot.id)?.role,
                      taskTitle: dashboard?.tasks.find((task) => task.id === slot.taskId)?.title,
                      access: slot.mode,
                      active: Boolean(slot.taskId),
                      status: sceneStatus(
                        dashboard,
                        workstationTask(dashboard, selected, slot.id),
                        Object.values(eventHistory).flat(),
                        connection.includes('disconnected'),
                        slot.id,
                      ),
                    }))}
                  selectedAgent={selectedAgent}
                  onSelect={selectStation}
                />
                <div className="scene-caption">
                  Two visible desks · all profiles in the activity roster · Tab / arrows to navigate
                </div>
              </section>
              <div className="stats" aria-label="Workspace statistics">
                <div>
                  <span>CODEX AGENTS</span>
                  <strong>
                    {dashboard?.agents.length ?? '—'}
                    <small>saved profiles</small>
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
                    SCOPED<small>Isolated writes / read-only</small>
                  </strong>
                </div>
              </div>
              {!!dashboard?.queue.length && (
                <section className="panel queue-panel" aria-label="Submitted queue">
                  <div className="panel-heading">
                    <h2>Submitted queue</h2>
                    <span>{dashboard.queue.length} / 100</span>
                  </div>
                  <ol>
                    {dashboard.queue.map((entry) => (
                      <li key={entry.taskId}>
                        <button
                          className="secondary"
                          onClick={() => {
                            setSelected(entry.taskId);
                            setSelectedAgent(entry.agentId);
                            setResumeSessionId('');
                          }}
                        >
                          {dashboard.tasks.find((task) => task.id === entry.taskId)?.title} ·{' '}
                          {entry.agentId}
                          <small> / {entry.waitingReason}</small>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {dashboard && (
                <AgentStudio
                  profiles={dashboard.profiles ?? []}
                  api={api}
                  refresh={refresh}
                  select={(id) => {
                    setSelectedAgent(id);
                    setResumeSessionId('');
                    showSection('compose');
                  }}
                />
              )}
              <section className="panel history" id="task-history">
                <div className="panel-heading">
                  <h2>Task history</h2>
                  <span className="subtle">{dashboard?.tasks.length ?? 0} tasks</span>
                </div>
                {!dashboard?.tasks.length ? (
                  <div className="empty-state">
                    <div>☷</div>
                    <h3>No reviews yet.</h3>
                    <p>
                      Your tasks and their results will appear here.
                      <br />
                      Choose a repository and describe your first read-only review.
                    </p>
                    <a href={dashboard?.repositories.length ? '#compose' : '#repositories'}>
                      {dashboard?.repositories.length
                        ? 'Create your first task →'
                        : 'Register a worktree →'}
                    </a>
                  </div>
                ) : (
                  <div className="task-list">
                    {dashboard.tasks.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={selected === item.id}
                        className={`task-row ${selected === item.id ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedAgent(item.agentId);
                          setSelected(item.id);
                          setResumeSessionId('');
                        }}
                      >
                        <span className={`task-indicator ${item.state}`} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.agentId} ·{' '}
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
              <section className="panel output" id="task-workspace" tabIndex={-1}>
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
                        {repository?.name} ·{' '}
                        {task.executionMode === 'write' ? 'Isolated write' : 'Read only'}
                      </span>
                      {view === 'focus' && task.id === agent?.taskId && stopControl}
                      {task.workspaceId &&
                        !['queued', 'running', 'stopping'].includes(task.state) && (
                          <a
                            className="review-shortcut"
                            href="#code-review-center"
                            onClick={() => setView('focus')}
                          >
                            Code Review Center ↗
                          </a>
                        )}
                      {task.state === 'queued' && !queued && (
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
                                  s.agentId === task.agentId &&
                                  s.repositoryId === task.repositoryId &&
                                  s.threadId &&
                                  s.authMode === dashboard.connection.mode &&
                                  (s.executionMode ?? 'read-only') ===
                                    (task.executionMode ?? 'read-only'),
                              )
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  Resume {s.threadId?.slice(0, 12)}… · pinned{' '}
                                  {s.configuration?.source === 'legacy'
                                    ? 'legacy'
                                    : `v${s.configuration?.profileRevision ?? '?'}`}
                                </option>
                              ))}
                          </select>
                          {resumeSessionId && (
                            <small>
                              Resumes the original pinned configuration; current profile edits do
                              not apply.
                            </small>
                          )}
                          <button
                            disabled={busy || !dashboard?.ready}
                            onClick={() =>
                              void act(async () => {
                                if (
                                  task.executionMode === 'write' &&
                                  !window.confirm(
                                    'Start a write-enabled Codex session in an isolated Git worktree? The agent can edit that worktree. Review and integration are manual.',
                                  )
                                )
                                  return;
                                await api(`/tasks/${task.id}/start`, {
                                  ...(resumeSessionId ? { resumeSessionId } : {}),
                                  confirmedWrite: task.executionMode === 'write',
                                });
                              })
                            }
                          >
                            ▶ Start task
                          </button>
                        </div>
                      )}
                    </div>
                    {queued && (
                      <div className="queue-notice" role="status">
                        Submitted / {queued.agentId} / queue #{queued.order}. {queued.waitingReason}
                        <button
                          className="secondary"
                          disabled={pendingStops.includes(task.id)}
                          onClick={() => void stopTask(task.id)}
                        >
                          Cancel queued task
                        </button>
                      </div>
                    )}
                    {taskConfiguration && (
                      <details className="configuration-record">
                        <summary>
                          Pinned configuration · {taskConfiguration.name} ·{' '}
                          {taskConfiguration.source === 'legacy'
                            ? 'legacy v0.5'
                            : `v${taskConfiguration.profileRevision}`}
                        </summary>
                        <p>
                          Current profile v
                          {dashboard?.profiles?.find((profile) => profile.id === task.agentId)
                            ?.revision ?? 'unavailable'}
                          . This task retains its submitted configuration.
                        </p>
                        <p>
                          {taskConfiguration.executionMode} ·{' '}
                          {taskConfiguration.model ??
                            'Connection default (resolved before execution)'}{' '}
                          · {taskConfiguration.policy}
                        </p>
                        <pre>
                          {taskConfiguration.role}
                          {'\n'}
                          {taskConfiguration.instructions}
                        </pre>
                      </details>
                    )}
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
                    {task.workspaceId &&
                      !['queued', 'running', 'stopping'].includes(task.state) && (
                        <ReviewCenter
                          key={task.id}
                          task={{ ...task, configuration: taskConfiguration }}
                          api={api}
                        />
                      )}
                    {task.executionMode !== 'write' &&
                      !['queued', 'running', 'stopping'].includes(task.state) && (
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
                                  {task.baselineFiles.some(
                                    (before) => before.path === file.path,
                                  ) && <small> · present before task</small>}
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
              <section className="panel compose" id="compose" tabIndex={-1}>
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
                        agentId: selectedAgent,
                        title: data.get('title'),
                        prompt: data.get('prompt'),
                        executionMode: data.get('executionMode'),
                      });
                      setSelected(created.id);
                      form.reset();
                      setExecutionMode('read-only');
                    });
                  }}
                >
                  <label htmlFor="assigned-agent">Assign to agent</label>
                  <select
                    id="assigned-agent"
                    value={selectedAgent}
                    onChange={(event) => {
                      setSelectedAgent(event.target.value as AgentId);
                      setResumeSessionId('');
                    }}
                  >
                    {!canAssign && (
                      <option value={selectedAgent} disabled>
                        Select an active profile
                      </option>
                    )}
                    {assignable.map((slot) => (
                      <option key={slot.id} value={slot.id}>
                        {slot.name} · {slot.id.slice(0, 8)} · {slot.state}
                      </option>
                    ))}
                  </select>
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
                  <label htmlFor="executionMode">Execution mode</label>
                  <select
                    id="executionMode"
                    name="executionMode"
                    value={executionMode}
                    onChange={(event) => setExecutionMode(event.target.value)}
                  >
                    <option value="read-only">Read-only review</option>
                    <option value="write" disabled={selectedProfile?.maximumMode !== 'write'}>
                      Isolated coding · write enabled
                    </option>
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
                      <span className="tiny-avatar">⌘</span> Assigned to{' '}
                      {agent?.name ?? 'Select a profile'}
                    </span>
                    <button disabled={busy || !repositoryId || !canAssign}>
                      Create task <span>→</span>
                    </button>
                  </div>
                </form>
                <p className="read-only-note">
                  Start submits to the assigned FIFO queue and may execute immediately. Isolated
                  coding requires confirmation and server-configured roots. Review changes before
                  keeping or rejecting; integration is manual.
                </p>
              </section>
            </div>
            <aside className="inspector" aria-label="Agent and connection inspector">
              <section className="panel agent-panel" id="agent" tabIndex={-1}>
                <div className="panel-heading">
                  <h2>Agents / {agent?.name ?? 'Codex'}</h2>
                  <span className="subtle">{dashboard?.concurrency ?? 2} slots</span>
                </div>
                <div
                  className="agent-switcher"
                  role="group"
                  aria-label="Select agent"
                  hidden={view !== 'focus'}
                >
                  {dashboard?.agents.map((slot) => (
                    <button
                      key={slot.id}
                      className="secondary"
                      aria-pressed={selectedAgent === slot.id}
                      onClick={() => {
                        setSelectedAgent(slot.id);
                        setSelected(workstationTask(dashboard, selected, slot.id)?.id);
                        setResumeSessionId('');
                      }}
                    >
                      {slot.name}
                      <small>{slot.state}</small>
                    </button>
                  ))}
                </div>
                <div className="agent-info">
                  <div className={`agent-avatar state-${scene.state}`}>
                    <PixelBot />
                  </div>
                  <div>
                    <h3>
                      {agent?.name}{' '}
                      <span className={`badge ${agent?.state ?? ''}`}>
                        {agent?.state ?? 'connecting'}
                      </span>
                    </h3>
                    <p>
                      OpenAI <span>·</span> Coding & repository review
                    </p>
                  </div>
                </div>
                <div className="agent-detail">
                  <span>Access mode</span>
                  <strong>
                    {selectedProfile?.maximumMode === 'write'
                      ? 'Isolated writes with confirmation'
                      : 'Read-only preference'}
                  </strong>
                </div>
                <div className="agent-detail">
                  <span>Workspace</span>
                  <strong>
                    {dashboard?.repositories.find(
                      (r) =>
                        r.id === dashboard.tasks.find((t) => t.id === agent?.taskId)?.repositoryId,
                    )?.name ?? 'Awaiting a task'}
                  </strong>
                </div>
                <div className="agent-detail">
                  <span>Saved sessions</span>
                  <strong>
                    {dashboard?.sessions.filter((session) => session.agentId === selectedAgent)
                      .length ?? 0}
                  </strong>
                </div>
                <div className="agent-note">
                  <span>↳</span>
                  <p>{dashboard?.readinessMessage ?? 'Connecting to the local backend…'}</p>
                </div>
                {(view === 'mission' || task?.id !== agent?.taskId) && stopControl}
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
              ▣ PHOSPHOR OS <span> / </span> HUMAN-DIRECTED AI / AGENT STUDIO · UNRELEASED
            </span>
            <span>LOCAL FIRST · HUMAN REVIEW · ISOLATED CODING</span>
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
