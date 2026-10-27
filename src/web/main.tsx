import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Dashboard, Task, AuthMode, AgentId } from '../shared/types.js';
import { AgentStudio } from './agent-studio.js';
import { WorkflowBoard } from './workflow-board.js';
import { ReviewCenter } from './review-center.js';
import { PixelBot, PixelOffice } from './pixel-art.js';
import { officeCheckpoint, type OfficeWorkflow } from './office-workflows.js';
import { sceneStatus, workstationTask } from './scene-state.js';
import {
  decodeTaskNavigation,
  encodeTaskNavigation,
  taskHasReview,
  taskNavigationTarget,
  type TaskDestination,
} from './task-navigation.js';
import {
  selectTaskHistory,
  summarizeTaskHistory,
  type TaskHistoryOrder,
  type TaskHistoryStatus,
} from './task-history-operations.js';
import { exportTaskHistoryCsv } from './task-history-export.js';
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
  const [screen, setScreen] = useState<'office' | 'tasks' | 'workflows' | 'team' | 'settings'>(
    () => {
      const hash = window.location.hash;
      if (hash.startsWith('#task-') || hash === '#compose') return 'tasks';
      if (hash.startsWith('#workflow')) return 'workflows';
      if (hash === '#agent-studio') return 'team';
      if (hash === '#agent') return 'office';
      if (hash === '#repositories' || hash === '#codex-connection') return 'settings';
      // Restore the active workspace after a reload. A direct deep link takes
      // precedence, and untrusted storage values never become screen selectors.
      try {
        const saved = sessionStorage.getItem('ai-office-workspace-screen');
        if (
          saved === 'office' ||
          saved === 'tasks' ||
          saved === 'workflows' ||
          saved === 'team' ||
          saved === 'settings'
        )
          return saved;
      } catch {
        /* Session storage is optional (private browsing / disabled storage). */
      }
      return 'office';
    },
  );
  useEffect(() => {
    try {
      sessionStorage.setItem('ai-office-workspace-screen', screen);
    } catch {
      /* Session storage is optional. */
    }
  }, [screen]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyStatus, setHistoryStatus] = useState<TaskHistoryStatus>('all');
  const [historyOrder, setHistoryOrder] = useState<TaskHistoryOrder>('attention');
  const [historyAgent, setHistoryAgent] = useState('');
  const [historyRepository, setHistoryRepository] = useState('');
  const [workflowInspection, setWorkflowInspection] = useState<{ id: string; request: number }>();
  const [workflows, setWorkflows] = useState<OfficeWorkflow[]>([]);
  const [workflowAvailable, setWorkflowAvailable] = useState(true);
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [selected, setSelected] = useState<string>();
  const [navigation, setNavigation] = useState(() => decodeTaskNavigation(window.location.hash));
  const lastNavigation = useRef('');
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      setNavigation(decodeTaskNavigation(hash));
      if (decodeTaskNavigation(hash)) {
        setScreen('tasks');
      } else if (hash === '#overview') {
        setScreen('office');
      } else if (hash === '#task-history' || hash === '#task-workspace' || hash === '#compose') {
        setScreen('tasks');
      } else if (hash === '#workflow-timeline' || hash === '#workflows') {
        setScreen('workflows');
      } else if (hash === '#agent-studio') {
        setScreen('team');
      } else if (hash === '#agent') {
        setScreen('office');
      } else if (hash === '#repositories' || hash === '#codex-connection') {
        setScreen('settings');
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
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
    let live = true;
    const load = async () => {
      try {
        const items = await api<OfficeWorkflow[]>('/workflows');
        if (live) {
          setWorkflows(items);
          setWorkflowAvailable(true);
        }
      } catch {
        if (live) {
          setWorkflows([]);
          setWorkflowAvailable(false);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
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
  useEffect(() => {
    if (!navigation || !dashboard) return;
    const target = dashboard.tasks.find((item) => item.id === navigation.taskId);
    if (!target || (navigation.destination === 'review' && !taskHasReview(target))) return;
    const key = encodeTaskNavigation(navigation);
    if (lastNavigation.current === key) return;
    if (selected !== target.id) setSelected(target.id);
    if (selectedAgent !== target.agentId) setSelectedAgent(target.agentId);
    setScreen('tasks');
    if (view !== 'focus') setView('focus');
  }, [navigation, dashboard, selected, selectedAgent, view]);
  useEffect(() => {
    if (!navigation || !dashboard || view !== 'focus' || selected !== navigation.taskId) return;
    const target = dashboard.tasks.find((item) => item.id === navigation.taskId);
    if (!target || (navigation.destination === 'review' && !taskHasReview(target))) return;
    const key = encodeTaskNavigation(navigation);
    if (lastNavigation.current === key) return;
    const id =
      navigation.destination === 'workflow'
        ? 'task-workflow'
        : navigation.destination === 'review'
          ? 'code-review-center'
          : 'task-workspace';
    const section = document.getElementById(id);
    if (!section) return;
    lastNavigation.current = key;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  }, [navigation, dashboard, selected, view]);
  const clearTaskNavigation = () => {
    setNavigation(null);
    lastNavigation.current = '';
    if (window.location.hash.startsWith('#task/')) {
      window.history.replaceState(null, '', '#task-history');
    }
  };
  const navigateTask = (item: Task, destination: TaskDestination) => {
    setScreen('tasks');
    const target = taskNavigationTarget(item, destination);
    if (!target) return;
    setSelected(item.id);
    setSelectedAgent(item.agentId);
    setResumeSessionId('');
    setView('focus');
    const hash = encodeTaskNavigation(target);
    if (window.location.hash === hash) {
      lastNavigation.current = '';
      setNavigation({ ...target });
    } else window.location.hash = hash;
  };
  const linkedTask = navigation && dashboard?.tasks.find((item) => item.id === navigation.taskId);
  const linkError =
    navigation && dashboard
      ? !linkedTask
        ? 'This task is no longer available in the local workspace.'
        : navigation.destination === 'review' && !taskHasReview(linkedTask)
          ? 'Code review is not available for this task. Open its session instead.'
          : ''
      : '';
  const taskSummary = summarizeTaskHistory(dashboard?.tasks ?? []);
  const visibleHistory = selectTaskHistory(dashboard?.tasks ?? [], {
    query: historyQuery,
    status: historyStatus,
    order: historyOrder,
    ...(historyAgent ? { agentId: historyAgent as AgentId } : {}),
    ...(historyRepository ? { repositoryId: historyRepository } : {}),
  });
  const task = dashboard?.tasks.find((item) => item.id === selected);
  const repository = dashboard?.repositories.find((item) => item.id === task?.repositoryId);
  const session = dashboard?.sessions.find((item) => item.id === task?.sessionId);
  const taskConfiguration = task?.configuration ?? session?.configuration;
  const agent = dashboard?.agents.find((item) => item.id === selectedAgent);
  const selectedProfile = dashboard?.profiles?.find((profile) => profile.id === selectedAgent);
  const officeAgents =
    dashboard?.agents.filter(
      (slot) =>
        !dashboard.profiles?.find((profile) => profile.id === slot.id)?.archived ||
        slot.taskId ||
        dashboard.tasks.some((task) => task.id === selected && task.agentId === slot.id),
    ) ?? [];
  const assignable =
    dashboard?.agents.filter(
      (slot) => !dashboard.profiles?.find((profile) => profile.id === slot.id)?.archived,
    ) ?? [];
  useEffect(() => {
    if (dashboard && !officeAgents.some((slot) => slot.id === selectedAgent) && officeAgents[0])
      setSelectedAgent(officeAgents[0].id);
  }, [dashboard, selectedAgent, selected]);
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
    workflows,
  );
  const stationTask = workstationTask(dashboard, selected, selectedAgent);
  const showSection = (id: string) => {
    if (id === 'compose' || id === 'task-workspace' || id === 'task-history') {
      setScreen('tasks');
      if (id === 'compose' || id === 'task-history') setView('mission');
    }
    if (id === 'workflows' || id === 'workflow-timeline' || id === 'task-workflow') {
      setScreen('workflows');
      setView('mission');
    }
    if (id === 'agent') {
      setScreen('office');
      setView('mission');
    }
    if (id === 'agent-studio') {
      setScreen('team');
      setView('mission');
    }
    if (id === 'repositories') {
      setScreen('settings');
      setView('mission');
    }
    if (id === 'overview') setScreen('office');
    const origin = document.activeElement;
    requestAnimationFrame(() => {
      // A later keyboard/pointer action takes precedence while its origin remains mounted.
      // Navigation can unmount the clicked control, moving focus to body; in that case,
      // continue and focus the destination section instead of abandoning navigation.
      const active = document.activeElement;
      // A hidden source can lose focus to body after its screen changes.
      // Preserve a newer focus target only when it remains visible and connected.
      if (
        active !== origin &&
        active instanceof Element &&
        active !== document.body &&
        active !== document.documentElement &&
        active.isConnected &&
        active.getClientRects().length > 0
      ) {
        return;
      }
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
    clearTaskNavigation();
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
      className={`shell unified-workspace ${crt ? 'crt-enabled' : ''} ${motion ? 'scene-motion' : ''} ${view === 'focus' ? 'focus-mode' : ''}`}
      data-screen={screen}
    >
      <a className="skip-link" href="#overview">
        Skip to mission control
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a
          className="brand"
          href="#overview"
          onClick={() => {
            setView('mission');
            setScreen('office');
          }}
        >
          <PixelBot />
          <span>
            AI OFFICE<small>A space for your agents</small>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Dashboard sections">
          {(
            [
              ['office', '⌂', 'Office', '#overview'],
              ['tasks', '▤', 'Tasks', '#task-history'],
              ['workflows', '◇', 'Workflows', '#workflow-timeline'],
              ['team', '♙', 'Team', '#agent-studio'],
              ['settings', '⚙', 'Settings', '#repositories'],
            ] as const
          ).map(([destination, icon, label, href]) => (
            <a
              key={destination}
              className={`nav-item ${screen === destination ? 'active' : ''}`}
              href={href}
              aria-current={screen === destination ? 'page' : undefined}
              onClick={() => {
                setView('mission');
                setScreen(destination);
              }}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
              {destination === 'tasks' && (
                <span className="nav-count">{dashboard?.tasks.length ?? 0}</span>
              )}
              {destination === 'team' && (
                <span className="nav-count">{dashboard?.agents.length ?? 0}</span>
              )}
            </a>
          ))}
          <button
            type="button"
            className="nav-item nav-create-task"
            onClick={() => {
              setView('mission');
              setScreen('tasks');
              showSection('compose');
            }}
          >
            <span aria-hidden="true">＋</span>New task
          </button>
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
        {linkError && (
          <div className="task-link-warning" role="alert">
            <p>{linkError}</p>
            <button className="secondary" type="button" onClick={clearTaskNavigation}>
              Dismiss task link
            </button>
          </div>
        )}
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
            title="Optional retro display effect. Reduced-motion settings disable the effect."
          >
            CRT effects: {crt ? 'on' : 'off'}
          </button>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">AI OFFICE / {screen.toUpperCase()}</div>
              <h1>
                {view === 'focus'
                  ? 'Focus mode'
                  : (
                      {
                        office: 'Office overview',
                        tasks: 'Tasks & activity',
                        workflows: 'Workflows',
                        team: 'Your team',
                        settings: 'Workspace settings',
                      } as const
                    )[screen]}
                <span>_</span>
              </h1>
              <p>
                {
                  (
                    {
                      office: 'See who is working and what needs your attention.',
                      tasks: 'Create tasks, follow progress and review results.',
                      workflows: 'Move work safely through review and QA.',
                      team: 'Manage the agents who work with you.',
                      settings: 'Manage repositories, connections and workspace access.',
                    } as const
                  )[screen]
                }
              </p>
            </div>
            <a
              className="button-link"
              href="#compose"
              onClick={() => {
                setView('mission');
                setScreen('tasks');
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
              Office overview
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
                  // Hashchange may run after the next frame. Show Settings immediately
                  // so the repository input is visible when the focus callback runs.
                  setScreen('settings');
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
          <section className="office-scene" aria-label="Shared Codex office">
            <PixelOffice
              agents={officeAgents.map((slot) => ({
                id: slot.id,
                name: slot.name,
                role: [
                  dashboard?.profiles?.find((profile) => profile.id === slot.id)?.role,
                  dashboard?.profiles?.find((profile) => profile.id === slot.id)?.archived
                    ? 'archived'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
                assignable: !dashboard?.profiles?.find((profile) => profile.id === slot.id)
                  ?.archived,
                taskId: workstationTask(dashboard, selected, slot.id)?.id,
                taskTitle: workstationTask(dashboard, selected, slot.id)?.title,
                taskState: workstationTask(dashboard, selected, slot.id)?.state,
                access:
                  workstationTask(dashboard, selected, slot.id)?.executionMode === 'write'
                    ? 'Isolated write'
                    : 'Read only',
                checkpoint: officeCheckpoint(workflows, slot.id)?.workflowId,
                active: Boolean(slot.taskId),
                status: sceneStatus(
                  dashboard,
                  workstationTask(dashboard, selected, slot.id),
                  Object.values(eventHistory).flat(),
                  connection.includes('disconnected'),
                  slot.id,
                  workflows,
                ),
              }))}
              recentTasks={(dashboard?.tasks ?? []).map((task) => ({
                id: task.id,
                agentId: task.agentId,
                title: task.title,
                state: task.state,
                updatedAt: task.updatedAt,
              }))}
              queue={(dashboard?.queue ?? []).map((entry) => ({
                taskId: entry.taskId,
                agentId: entry.agentId,
                title:
                  dashboard?.tasks.find((task) => task.id === entry.taskId)?.title ??
                  'Untitled task',
                order: entry.order,
                waitingReason: entry.waitingReason,
              }))}
              selectedAgent={selectedAgent}
              onSelect={selectStation}
              transport={
                !dashboard
                  ? connection.includes('disconnected')
                    ? 'unavailable'
                    : 'loading'
                  : connection.includes('disconnected')
                    ? 'disconnected'
                    : 'connected'
              }
              onAssign={() => showSection('compose')}
              onInspectSession={() => {
                if (stationTask) {
                  setSelected(stationTask.id);
                  setView('focus');
                  showSection('task-workspace');
                }
              }}
              onInspectTask={(taskId) => {
                const target = dashboard?.tasks.find((item) => item.id === taskId);
                if (target) {
                  setSelectedAgent(target.agentId);
                  setSelected(target.id);
                  setResumeSessionId('');
                  showSection('task-workspace');
                }
              }}
              onCheckpoint={() => {
                const checkpoint = officeCheckpoint(workflows, selectedAgent);
                if (checkpoint) {
                  setWorkflowInspection({ id: checkpoint.workflowId, request: Date.now() });
                  showSection('workflows');
                }
              }}
            />
            {!workflowAvailable && (
              <p className="studio-notice" role="status">
                Workflow status unavailable. Open workflow details to retry.
              </p>
            )}
          </section>
          <div className="mission-grid">
            <div className="mission-board">
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
                            showSection('task-workspace');
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
              <section id="workflow-timeline" aria-label="Workflows" tabIndex={-1}>
                <WorkflowBoard inspection={workflowInspection} />
              </section>
              <section className="panel history" id="task-history">
                <div className="panel-heading">
                  <h2>Task history</h2>
                  <span className="subtle">{dashboard?.tasks.length ?? 0} tasks</span>
                </div>
                {!!dashboard?.tasks.length && (
                  <div className="history-controls" aria-label="Task history filters">
                    <button
                      type="button"
                      className="secondary"
                      disabled={visibleHistory.length === 0}
                      title="Export filtered task metadata only. Prompts, logs and paths are excluded."
                      onClick={() => {
                        const csv = exportTaskHistoryCsv(visibleHistory);
                        const url = URL.createObjectURL(
                          new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
                        );
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = 'ai-office-task-history.csv';
                        link.click();
                        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      Export filtered CSV ({visibleHistory.length})
                    </button>
                    <p role="status">
                      {taskSummary.active} active · {taskSummary.queued} queued ·{' '}
                      {taskSummary.attention} failed/interrupted · {taskSummary.completed} completed
                    </p>
                    <label>
                      Search tasks
                      <input
                        type="search"
                        value={historyQuery}
                        onChange={(event) => setHistoryQuery(event.target.value)}
                        placeholder="Title or task ID"
                      />
                    </label>
                    <label>
                      Task state
                      <select
                        value={historyStatus}
                        onChange={(event) =>
                          setHistoryStatus(event.target.value as TaskHistoryStatus)
                        }
                      >
                        <option value="all">All states</option>
                        <option value="attention">Failed / interrupted</option>
                        <option value="active">Running / stopping</option>
                        <option value="queued">Queued</option>
                        <option value="completed">Completed</option>
                      </select>
                    </label>
                    <label>
                      Agent
                      <select
                        value={historyAgent}
                        onChange={(event) => setHistoryAgent(event.target.value)}
                      >
                        <option value="">All agents</option>
                        {dashboard?.agents.map((slot) => (
                          <option key={slot.id} value={slot.id}>
                            {slot.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Repository
                      <select
                        value={historyRepository}
                        onChange={(event) => setHistoryRepository(event.target.value)}
                      >
                        <option value="">All repositories</option>
                        {dashboard?.repositories.map((repo) => (
                          <option key={repo.id} value={repo.id}>
                            {repo.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Sort
                      <select
                        value={historyOrder}
                        onChange={(event) =>
                          setHistoryOrder(event.target.value as TaskHistoryOrder)
                        }
                      >
                        <option value="attention">Attention first</option>
                        <option value="recent">Most recently updated</option>
                        <option value="oldest">Oldest updates</option>
                      </select>
                    </label>
                    <p role="status">
                      {visibleHistory.length} of {taskSummary.total} tasks shown
                    </p>
                    {(historyQuery ||
                      historyStatus !== 'all' ||
                      historyAgent ||
                      historyRepository ||
                      historyOrder !== 'attention') && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setHistoryQuery('');
                          setHistoryStatus('all');
                          setHistoryOrder('attention');
                          setHistoryAgent('');
                          setHistoryRepository('');
                        }}
                      >
                        Reset task filters
                      </button>
                    )}
                  </div>
                )}
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
                    {visibleHistory.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={selected === item.id}
                        className={`task-row ${selected === item.id ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedAgent(item.agentId);
                          setSelected(item.id);
                          setResumeSessionId('');
                          clearTaskNavigation();
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
                    {visibleHistory.length === 0 && (
                      <p role="status">
                        No tasks match these filters. Reset filters to see the full history.
                      </p>
                    )}
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
                      <nav className="task-navigation" aria-label="Selected task navigation">
                        <a
                          href={encodeTaskNavigation({ taskId: task.id, destination: 'session' })}
                          onClick={(event) => {
                            event.preventDefault();
                            navigateTask(task, 'session');
                          }}
                        >
                          Session
                        </a>
                        {taskHasReview(task) && (
                          <a
                            href={encodeTaskNavigation({ taskId: task.id, destination: 'review' })}
                            onClick={(event) => {
                              event.preventDefault();
                              navigateTask(task, 'review');
                            }}
                          >
                            Code review
                          </a>
                        )}
                        <a
                          href={encodeTaskNavigation({ taskId: task.id, destination: 'workflow' })}
                          onClick={(event) => {
                            event.preventDefault();
                            navigateTask(task, 'workflow');
                          }}
                        >
                          Workflow &amp; QA
                        </a>
                      </nav>
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
                    {taskHasReview(task) ? (
                      <ReviewCenter
                        key={task.id}
                        task={{ ...task, configuration: taskConfiguration }}
                        api={api}
                      />
                    ) : (
                      <div id="task-workflow" tabIndex={-1}>
                        <WorkflowBoard taskId={task.id} />
                      </div>
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
                      clearTaskNavigation();
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
              <section
                className="panel connection-panel"
                id="codex-connection"
                aria-label="Codex connection"
              >
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
