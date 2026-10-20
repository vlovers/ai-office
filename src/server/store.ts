import {
  legacyConfiguration,
  profileConfiguration,
  assertConfiguration,
} from './execution-config.js';
import type { ExecutionConfiguration } from '../shared/types.js';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from './workflows.js';
import { AppError } from './errors.js';
import type { AgentSettings } from './agents.js';
import type { AgentProfile } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import type {
  ReviewRecord,
  ReviewComment,
  WorkspaceReview,
  Repository,
  Workspace,
  ExecutionMode,
  Task,
  Session,
  AgentEvent,
  AgentId,
  AuthMode,
  QueueEntry,
} from '../shared/types.js';
import type { SessionBinding } from './providers/types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 9) {
      this.db.close();
      throw new Error('Metadata schema is newer than this AI Office version.');
    }
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
      CREATE INDEX IF NOT EXISTS events_task_id ON events(task_id,id);
      CREATE TABLE IF NOT EXISTS session_bindings (session_id TEXT PRIMARY KEY REFERENCES sessions(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL REFERENCES tasks(id),
        resume_session_id TEXT REFERENCES sessions(id),
        mode TEXT NOT NULL,
        enqueued_at TEXT NOT NULL
      );`);
      // Old tasks remain unsubmitted. Legacy task/session ownership belongs to Codex 01.
      for (const task of this.tasks()) {
        if (!task.agentId) this.updateTask(task.id, { agentId: 'codex-1' });
      }
      for (const session of this.sessions()) {
        if (!session.agentId)
          this.db
            .prepare('UPDATE sessions SET json=? WHERE id=?')
            .run(JSON.stringify({ ...session, agentId: 'codex-1' }), session.id);
      }
      for (const task of this.tasks()) {
        if (['running', 'stopping'].includes(task.state)) {
          this.removeQueued(task.id);
          this.updateTask(task.id, {
            state: 'interrupted',
            error:
              'Server terminated before the task finished. Inspect the repository before resuming.',
          });
          this.addEvent(task.id, 'interrupted', 'Recovered unfinished task after server restart.');
          const workspace = task.workspaceId ? this.workspace(task.workspaceId) : undefined;
          if (workspace) this.saveWorkspace({ ...workspace, reviewEpoch: task.id });
        }
      }
      for (const workspace of this.workspaces()) {
        if (workspace.operation)
          this.saveWorkspace({
            ...workspace,
            recoveryError: `Interrupted workspace ${workspace.operation}. Preserve files and branches; inspect processes, Git worktree list and the lease before manual recovery.`,
          });
        else if (!workspace.identity && workspace.decision !== 'rejected')
          this.saveWorkspace({
            ...workspace,
            recoveryError:
              'Legacy workspace has no ownership fingerprint. Preserve its files; manual inspection and integration are required.',
          });
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS review_records (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        revision TEXT NOT NULL,
        number INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(workspace_id, revision),
        UNIQUE(workspace_id, number)
      );`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY, position INTEGER UNIQUE NOT NULL, json TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS agent_versions (
        agent_id TEXT NOT NULL REFERENCES agent_profiles(id), revision INTEGER NOT NULL,
        json TEXT NOT NULL, PRIMARY KEY(agent_id, revision)
      );`);
      if (version < 7) {
        for (const owner of [...this.tasks(), ...this.sessions()])
          if (!['codex-1', 'codex-2'].includes(owner.agentId ?? ''))
            throw new Error(
              'Unknown legacy agent owner. Preserve metadata and inspect before upgrading.',
            );
        for (const [index, id] of ['codex-1', 'codex-2'].entries()) {
          if (!this.agent(id))
            this.insertAgent({
              id,
              provider: 'codex',
              name: `Codex ${index ? '02' : '01'}`,
              role: 'Coding assistant',
              description: '',
              instructions: '',
              model: null,
              maximumMode: 'read-only',
              revision: 1,
              archived: false,
              order: index + 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
        }
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_configurations (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), submission TEXT NOT NULL, execution TEXT
      ); CREATE TABLE IF NOT EXISTS session_configurations (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), json TEXT NOT NULL
      );`);
      if (version < 8) {
        for (const session of this.sessions()) {
          const config = legacyConfiguration(session);
          config.model = this.sessionBinding(session.id)?.model ?? session.model ?? null;
          this.saveSessionConfiguration(session.id, config);
        }
        for (const entry of this.queue()) {
          const task = this.task(entry.taskId)!;
          const config = entry.resumeSessionId
            ? this.sessionConfiguration(entry.resumeSessionId)
            : legacyConfiguration(task);
          this.pinConfiguration(task, config);
        }
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS workflows_repository ON workflows(repository_id, created_at);
      PRAGMA user_version=9; COMMIT;`);
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* transaction may not have opened */
      }
      this.db.close();
      throw error;
    }
    // Fail closed after schema migration and task recovery, before queue dispatch.
    new WorkflowStore(this.db).recoverInterrupted();
  }
  taskConfiguration(id: string): ExecutionConfiguration | undefined {
    const row = this.db
      .prepare(
        'SELECT coalesce(execution,submission) AS json FROM task_configurations WHERE task_id=?',
      )
      .get(id);
    return row ? (JSON.parse(String(row.json)) as ExecutionConfiguration) : undefined;
  }
  sessionConfiguration(id: string): ExecutionConfiguration | undefined {
    const row = this.db
      .prepare('SELECT json FROM session_configurations WHERE session_id=?')
      .get(id);
    return row ? (JSON.parse(String(row.json)) as ExecutionConfiguration) : undefined;
  }
  saveSessionConfiguration(id: string, config: ExecutionConfiguration) {
    this.db
      .prepare('INSERT INTO session_configurations VALUES (?,?)')
      .run(id, JSON.stringify(config));
  }
  pinConfiguration(task: Task, config?: ExecutionConfiguration) {
    const selected = assertConfiguration(
      config ?? profileConfiguration(this.requireAgent(task.agentId), task),
      task,
    );
    this.db
      .prepare('INSERT INTO task_configurations(task_id,submission) VALUES (?,?)')
      .run(task.id, JSON.stringify(selected));
    return selected;
  }
  effectiveConfiguration(taskId: string, config: ExecutionConfiguration) {
    const row = this.db
      .prepare('SELECT execution FROM task_configurations WHERE task_id=?')
      .get(taskId);
    if (!row || row.execution)
      throw new AppError(409, 'Execution configuration is already pinned or missing.');
    this.db
      .prepare('UPDATE task_configurations SET execution=? WHERE task_id=?')
      .run(JSON.stringify(config), taskId);
  }
  agents(): AgentProfile[] {
    return this.db
      .prepare('SELECT json FROM agent_profiles ORDER BY position')
      .all()
      .map((row) => JSON.parse(String(row.json)) as AgentProfile);
  }
  agent(id: string): AgentProfile | undefined {
    const row = this.db.prepare('SELECT json FROM agent_profiles WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.json)) as AgentProfile) : undefined;
  }
  agentVersion(id: string, revision: number): AgentProfile | undefined {
    const row = this.db
      .prepare('SELECT json FROM agent_versions WHERE agent_id=? AND revision=?')
      .get(id, revision);
    return row ? (JSON.parse(String(row.json)) as AgentProfile) : undefined;
  }
  private insertAgent(profile: AgentProfile) {
    this.db
      .prepare('INSERT INTO agent_profiles VALUES (?,?,?)')
      .run(profile.id, profile.order, JSON.stringify(profile));
    this.db
      .prepare('INSERT INTO agent_versions VALUES (?,?,?)')
      .run(profile.id, profile.revision, JSON.stringify(profile));
    return profile;
  }
  createAgent(settings: AgentSettings): AgentProfile {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const order = Number(
        this.db.prepare('SELECT coalesce(max(position),0)+1 AS next FROM agent_profiles').get()!
          .next,
      );
      const profile = this.insertAgent({
        ...settings,
        id: randomUUID(),
        provider: 'codex',
        revision: 1,
        archived: false,
        order,
        createdAt: now,
        updatedAt: now,
      });
      this.db.exec('COMMIT');
      return profile;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  editAgent(
    id: string,
    revision: number,
    patch: AgentSettings | { archived: boolean },
  ): AgentProfile {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.requireAgent(id, revision);
      const profile = {
        ...previous,
        ...patch,
        revision: previous.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare('UPDATE agent_profiles SET json=? WHERE id=?')
        .run(JSON.stringify(profile), id);
      this.db
        .prepare('INSERT INTO agent_versions VALUES (?,?,?)')
        .run(id, profile.revision, JSON.stringify(profile));
      this.db.exec('COMMIT');
      return profile;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  requireAgent(id: string, revision?: number): AgentProfile {
    const profile = this.agent(id);
    if (!profile) throw new AppError(404, 'Agent profile not found.');
    if (revision !== undefined && revision !== profile.revision)
      throw new AppError(409, 'Agent profile changed. Reload before saving.');
    return profile;
  }
  repositories(): Repository[] {
    return this.rows('repositories');
  }
  tasks(): Task[] {
    return this.rows<Task>('tasks').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  sessions(): Session[] {
    return this.rows('sessions');
  }
  private rows<T>(table: 'repositories' | 'tasks' | 'sessions' | 'workspaces'): T[] {
    return this.db
      .prepare(`SELECT json FROM ${table}`)
      .all()
      .map((row) => JSON.parse(row.json as string) as T);
  }
  task(id: string) {
    return this.tasks().find((task) => task.id === id);
  }
  repository(id: string) {
    return this.repositories().find((repo) => repo.id === id);
  }
  session(id: string) {
    return this.sessions().find((session) => session.id === id);
  }
  register(repository: Omit<Repository, 'id' | 'createdAt'>): Repository {
    const existing = this.repositories().find((repo) => repo.path === repository.path);
    if (existing) return existing;
    const row = { ...repository, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO repositories VALUES (?,?,?)')
      .run(row.id, row.path, JSON.stringify(row));
    return row;
  }
  createTask(input: {
    repositoryId: string;
    reviewRequest?: Task['reviewRequest'];
    title: string;
    prompt: string;
    executionMode?: ExecutionMode;
    agentId?: AgentId;
  }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      ...input,
      id: randomUUID(),
      agentId: input.agentId ?? 'codex-1',
      sessionId: null,
      state: 'queued',
      result: '',
      error: null,
      changedFiles: [],
      baselineFiles: [],
      summaryError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO tasks VALUES (?,?,?,?)')
      .run(task.id, task.repositoryId, task.state, JSON.stringify(task));
    return task;
  }
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | 'workspaceId'
        | 'executionMode'
        | 'agentId'
        | 'state'
        | 'sessionId'
        | 'result'
        | 'error'
        | 'changedFiles'
        | 'baselineFiles'
        | 'summaryError'
      >
    >,
  ) {
    const task = this.task(id);
    if (!task) throw new Error('Task missing');
    const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare('UPDATE tasks SET state=?,json=? WHERE id=?')
      .run(updated.state, JSON.stringify(updated), id);
    return updated;
  }
  createSession(
    repositoryId: string,
    binding?: SessionBinding,
    provider = 'codex',
    agentId: AgentId = 'codex-1',
    executionMode: ExecutionMode = 'read-only',
    workspaceId?: string,
    configuration?: ExecutionConfiguration,
  ) {
    const session: Session = {
      id: randomUUID(),
      repositoryId,
      executionMode,
      workspaceId,
      provider,
      agentId,
      threadId: null,
      createdAt: new Date().toISOString(),
      ...(binding ? { authMode: binding.mode, model: binding.model } : {}),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO sessions VALUES (?,?,?)')
        .run(session.id, repositoryId, JSON.stringify(session));
      if (binding)
        this.db
          .prepare('INSERT INTO session_bindings VALUES (?,?)')
          .run(session.id, JSON.stringify(binding));
      if (configuration) this.saveSessionConfiguration(session.id, configuration);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return session;
  }
  workspaces(): Workspace[] {
    return this.rows('workspaces');
  }
  attachWorkspace(taskId: string, workspace: Workspace) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveWorkspace(workspace);
      this.updateTask(taskId, { workspaceId: workspace.id });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  workspace(id: string): Workspace | undefined {
    const row = this.db.prepare('SELECT json FROM workspaces WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.json)) as Workspace) : undefined;
  }
  saveWorkspace(workspace: Workspace) {
    this.db
      .prepare(
        'INSERT INTO workspaces VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
      )
      .run(workspace.id, JSON.stringify(workspace));
    return workspace;
  }
  sessionBinding(id: string): SessionBinding | undefined {
    const row = this.db.prepare('SELECT json FROM session_bindings WHERE session_id=?').get(id);
    return row ? (JSON.parse(row.json as string) as SessionBinding) : undefined;
  }
  setThread(id: string, threadId: string) {
    const session = this.session(id);
    if (!session) throw new Error('Session missing');
    this.db
      .prepare('UPDATE sessions SET json=? WHERE id=?')
      .run(JSON.stringify({ ...session, threadId }), id);
  }
  addEvent(taskId: string, kind: string, message: string, data?: unknown): AgentEvent {
    const at = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO events(task_id,at,kind,message,data) VALUES (?,?,?,?,?)')
      .run(taskId, at, kind, message, data === undefined ? null : JSON.stringify(data));
    return { id: Number(result.lastInsertRowid), taskId, at, kind, message, data };
  }
  events(taskId: string, after = 0): AgentEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 500')
      .all(taskId, after)
      .map((row) => ({
        id: row.id as number,
        taskId: row.task_id as string,
        at: row.at as string,
        kind: row.kind as string,
        message: row.message as string,
        ...(row.data ? { data: JSON.parse(row.data as string) } : {}),
      }));
  }
  queue(): QueueEntry[] {
    return this.db
      .prepare('SELECT * FROM task_queue ORDER BY sequence')
      .all()
      .map((row) => ({
        taskId: String(row.task_id),
        agentId: this.task(String(row.task_id))!.agentId,
        order: Number(row.sequence),
        enqueuedAt: String(row.enqueued_at),
        mode: row.mode as AuthMode,
        resumeSessionId: row.resume_session_id as string | null,
      }));
  }
  enqueue(taskId: string, mode: AuthMode, resumeSessionId?: string, transaction = true) {
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.task(taskId);
      if (!task) throw new AppError(404, 'Task not found.');
      const config = resumeSessionId ? this.sessionConfiguration(resumeSessionId) : undefined;
      if (resumeSessionId && !config)
        throw new AppError(409, 'Saved session configuration is missing.');
      const pinned = this.pinConfiguration(task, config);
      if (mode === 'api-key' && pinned.model === null)
        throw new AppError(
          409,
          'API-key execution requires an explicit model ID in the agent profile. Saved sessions without a model cannot be safely resumed.',
        );
      this.db
        .prepare(
          'INSERT INTO task_queue(task_id,resume_session_id,mode,enqueued_at) VALUES (?,?,?,?)',
        )
        .run(taskId, resumeSessionId ?? null, mode, new Date().toISOString());
      if (transaction) this.db.exec('COMMIT');
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  removeQueued(taskId: string) {
    this.db.prepare('DELETE FROM task_queue WHERE task_id=?').run(taskId);
  }
  claimQueued(taskId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !this.queue().some((entry) => entry.taskId === taskId) ||
        this.task(taskId)?.state !== 'queued'
      )
        throw new Error('Queue claim is stale.');
      this.updateTask(taskId, { state: 'running' });
      this.removeQueued(taskId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  reviewRecords(workspaceId: string, before = Number.MAX_SAFE_INTEGER): ReviewRecord[] {
    return this.db
      .prepare(
        'SELECT json FROM review_records WHERE workspace_id=? AND number<? ORDER BY number DESC LIMIT 20',
      )
      .all(workspaceId, before)
      .map((row) => JSON.parse(String(row.json)) as ReviewRecord);
  }
  reviewRecord(workspaceId: string, revision: string) {
    const row = this.db
      .prepare('SELECT json FROM review_records WHERE workspace_id=? AND revision=?')
      .get(workspaceId, revision);
    return row ? (JSON.parse(String(row.json)) as ReviewRecord) : undefined;
  }
  captureReview(task: Task, review: WorkspaceReview) {
    const existing = this.reviewRecord(review.workspace.id, review.revision!);
    if (existing) return existing;
    // A canceled or preflight-failed correction has not attached an executed session yet.
    // Retain only its explicitly pinned source session; never infer another workspace thread.
    const sessionId = task.sessionId ?? task.reviewRequest?.sessionId;
    const session = sessionId ? this.session(sessionId) : undefined;
    const record: ReviewRecord = {
      workspaceId: review.workspace.id,
      taskId: task.id,
      revision: review.revision!,
      number: (this.reviewRecords(review.workspace.id)[0]?.number ?? 0) + 1,
      createdAt: new Date().toISOString(),
      files: review.files,
      comments: [],
      version: 0,
      sessionId: session?.id ?? null,
      threadId: task.reviewRequest?.threadId ?? session?.threadId ?? null,
      verification: review.workspace.verification,
      configuration:
        this.taskConfiguration(task.id) ??
        (sessionId ? this.sessionConfiguration(sessionId) : undefined),
    };
    this.db
      .prepare('INSERT INTO review_records VALUES (?,?,?,?)')
      .run(record.workspaceId, record.revision, record.number, JSON.stringify(record));
    return record;
  }
  saveReviewRecord(record: ReviewRecord) {
    this.db
      .prepare('UPDATE review_records SET json=? WHERE workspace_id=? AND revision=?')
      .run(JSON.stringify(record), record.workspaceId, record.revision);
    return record;
  }
  saveComments(record: ReviewRecord, comments: ReviewComment[]) {
    return this.saveReviewRecord({ ...record, comments, version: record.version + 1 });
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
}
