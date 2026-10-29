import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Dashboard, Task, AuthMode, AgentId } from '../shared/types.js';
import { AgentsPage } from './agents-page.js';
import { MainNavigation } from './main-navigation.js';
import { PageHeading } from './page-heading.js';
import { OfficePage, WorkspacePage } from './workspace-pages.js';
import { TaskPanelTabs, type TaskPanel } from './task-panel-tabs.js';
import { TaskSummary } from './task-summary.js';
import { TaskHistory } from './task-history.js';
import { TaskComposer } from './task-composer.js';
import { TaskSessionOutput } from './task-session-output.js';
import { TaskChangedFiles } from './task-changed-files.js';
import { TaskSessionControls } from './task-session-controls.js';
import { SubmittedQueue } from './submitted-queue.js';
import {
  destinationForSection,
  destinationFromHash,
  destinationHash,
  type Destination,
} from './destinations.js';
import { WorkflowsPage } from './workflows-page.js';
import { SettingsPage } from './settings-page.js';
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
  const [page, setPage] = useState<Destination>(() => destinationFromHash(window.location.hash));
  const [taskPanel, setTaskPanel] = useState<TaskPanel>(() =>
    window.location.hash === '#compose' ? 'new' : 'details',
  );
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
      setNavigation(decodeTaskNavigation(window.location.hash));
      setPage(destinationFromHash(window.location.hash));
      setTaskPanel(window.location.hash === '#compose' ? 'new' : 'details');
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
    if (taskPanel !== 'details') setTaskPanel('details');
    if (selectedAgent !== target.agentId) setSelectedAgent(target.agentId);
    if (view !== 'focus') setView('focus');
    if (page !== 'tasks') setPage('tasks');
  }, [navigation, dashboard, selected, selectedAgent, view, page, taskPanel]);
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
    const target = taskNavigationTarget(item, destination);
    if (!target) return;
    setSelected(item.id);
    setTaskPanel('details');
    setSelectedAgent(item.agentId);
    setResumeSessionId('');
    setView('focus');
    setPage('tasks');
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
    const targetPage = destinationForSection(id);
    setPage(targetPage);
    if (targetPage === 'tasks') setTaskPanel(id === 'compose' ? 'new' : 'details');
    const targetHash = `#${id}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, '', targetHash);
      setNavigation(decodeTaskNavigation(targetHash));
    }
    const origin = document.activeElement;
    requestAnimationFrame(() => {
      // A later keyboard/pointer action takes precedence over this deferred navigation.
      if (document.activeElement !== origin && origin?.isConnected) return;
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
      data-page={page}
      data-task-panel={taskPanel}
      className={`shell ${crt ? 'crt-enabled' : ''} ${motion ? 'scene-motion' : ''} ${view === 'focus' ? 'focus-mode' : ''}`}
    >
      <a className="skip-link" href="#overview">
        Skip to mission control
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a
          className="brand"
          href="#overview"
          onClick={() => {
            setPage('office');
            setView('mission');
          }}
        >
          <PixelBot />
          <span>
            AI OFFICE<small>A space for your agents</small>
          </span>
        </a>
        <div className="nav-label">// MISSION DIRECTORY</div>
        <MainNavigation
          page={page}
          taskCount={dashboard?.tasks.length ?? 0}
          onNavigate={(destination) => {
            setPage(destination);
            setView('mission');
            window.location.hash = destinationHash(destination);
            window.scrollTo({ top: 0 });
          }}
        />
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
          <PageHeading
            page={page}
            focus={view === 'focus'}
            onNewTask={() => {
              setView('mission');
              showSection('compose');
            }}
          />
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
          {page === 'office' && (
            <OfficePage>
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
            </OfficePage>
          )}
          {page === 'tasks' && (
            <TaskPanelTabs
              active={taskPanel}
              onChange={(panel) => {
                setTaskPanel(panel);
                if (panel === 'new') showSection('compose');
                else showSection('task-workspace');
              }}
            />
          )}
          {page !== 'office' && (
            <WorkspacePage
              page={page}
              board={
                <>
                  {page === 'tasks' && <TaskSummary dashboard={dashboard} />}
                  {page === 'tasks' && (
                    <SubmittedQueue
                      dashboard={dashboard}
                      onSelect={(taskId, agentId) => {
                        setSelected(taskId);
                        setTaskPanel('details');
                        setSelectedAgent(agentId);
                        setResumeSessionId('');
                      }}
                    />
                  )}
                  {page === 'agents' && dashboard && (
                    <AgentsPage
                      profiles={dashboard.profiles ?? []}
                      api={api}
                      refresh={refresh}
                      onSelect={(id) => {
                        setSelectedAgent(id);
                        setResumeSessionId('');
                        showSection('compose');
                      }}
                    />
                  )}
                  {page === 'workflows' && <WorkflowsPage inspection={workflowInspection} />}
                  {page === 'settings' && (
                    <SettingsPage
                      dashboard={dashboard}
                      busy={busy}
                      agentBusy={agentBusy}
                      onChangeMode={(mode) => {
                        void act(async () => {
                          await api('/connection', { mode });
                          setResumeSessionId('');
                        });
                      }}
                      onRefreshConnection={() => {
                        void act(async () => {
                          await api('/connection/refresh', {});
                        });
                      }}
                      onRegisterRepository={(path, form) => {
                        void act(async () => {
                          const repo = await api<{ id: string }>('/repositories', { path });
                          setRepositoryId(repo.id);
                          setResumeSessionId('');
                          form.reset();
                        });
                      }}
                    />
                  )}
                  {page === 'tasks' && (
                    <TaskHistory
                      dashboard={dashboard}
                      visibleHistory={visibleHistory}
                      taskSummary={taskSummary}
                      historyQuery={historyQuery}
                      historyStatus={historyStatus}
                      historyOrder={historyOrder}
                      historyAgent={historyAgent}
                      historyRepository={historyRepository}
                      selected={selected}
                      onQueryChange={setHistoryQuery}
                      onStatusChange={setHistoryStatus}
                      onOrderChange={setHistoryOrder}
                      onAgentChange={setHistoryAgent}
                      onRepositoryChange={setHistoryRepository}
                      onSelectTask={(item) => {
                        setSelectedAgent(item.agentId);
                        setSelected(item.id);
                        setTaskPanel('details');
                        setResumeSessionId('');
                        clearTaskNavigation();
                      }}
                    />
                  )}
                  {page === 'tasks' && (
                    <section
                      className="panel output"
                      id="task-workspace"
                      tabIndex={-1}
                      data-task-panel="details"
                    >
                      <div className="panel-heading">
                        <h2>
                          Task workspace{' '}
                          {task && <span className="output-title">/ {task.title}</span>}
                        </h2>
                        <span className="subtle">LIVE OUTPUT</span>
                      </div>
                      {!task ? (
                        <div className="output-empty">
                          <span>↳</span> Select a task to follow its progress and review the result.
                        </div>
                      ) : (
                        <>
                          <TaskSessionControls
                            task={task}
                            repositoryName={repository?.name}
                            dashboard={dashboard}
                            queued={queued}
                            taskConfiguration={taskConfiguration}
                            resumeSessionId={resumeSessionId}
                            busy={busy}
                            stopPending={pendingStops.includes(task.id)}
                            showStopControl={view === 'focus' && task.id === agent?.taskId}
                            stopControl={stopControl}
                            onNavigate={navigateTask}
                            onFocus={() => setView('focus')}
                            onResumeSessionChange={setResumeSessionId}
                            onStartTask={() => {
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
                              });
                            }}
                            onStopTask={() => void stopTask(task.id)}
                          />
                          <TaskSessionOutput task={task} session={session} events={events} />
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
                          <TaskChangedFiles task={task} />
                        </>
                      )}
                    </section>
                  )}
                  {page === 'tasks' && (
                    <TaskComposer
                      dashboard={dashboard}
                      selectedAgent={selectedAgent}
                      repositoryId={repositoryId}
                      executionMode={executionMode}
                      selectedProfile={selectedProfile}
                      assignable={assignable}
                      canAssign={canAssign}
                      agentName={agent?.name}
                      busy={busy}
                      onAgentChange={(id) => {
                        setSelectedAgent(id);
                        setResumeSessionId('');
                      }}
                      onRepositoryChange={(id) => {
                        setRepositoryId(id);
                        setResumeSessionId('');
                      }}
                      onExecutionModeChange={setExecutionMode}
                      onCreateTask={(input, form) => {
                        void act(async () => {
                          const created = await api<Task>('/tasks', {
                            repositoryId,
                            agentId: selectedAgent,
                            ...input,
                          });
                          setSelected(created.id);
                          setTaskPanel('details');
                          clearTaskNavigation();
                          form.reset();
                          setExecutionMode('read-only');
                        });
                      }}
                    />
                  )}
                </>
              }
              inspector={
                <>
                  {page === 'agents' && (
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
                              r.id ===
                              dashboard.tasks.find((t) => t.id === agent?.taskId)?.repositoryId,
                          )?.name ?? 'Awaiting a task'}
                        </strong>
                      </div>
                      <div className="agent-detail">
                        <span>Saved sessions</span>
                        <strong>
                          {dashboard?.sessions.filter(
                            (session) => session.agentId === selectedAgent,
                          ).length ?? 0}
                        </strong>
                      </div>
                      <div className="agent-note">
                        <span>↳</span>
                        <p>{dashboard?.readinessMessage ?? 'Connecting to the local backend…'}</p>
                      </div>
                      {(view === 'mission' || task?.id !== agent?.taskId) && stopControl}
                    </section>
                  )}
                </>
              }
            />
          )}
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
