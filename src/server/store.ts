import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
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
    if (version > 4) {
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
        }
      }
      this.db.exec('PRAGMA user_version=4; COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* transaction may not have opened */
      }
      this.db.close();
      throw error;
    }
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
  private rows<T>(table: 'repositories' | 'tasks' | 'sessions'): T[] {
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
    this.db
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run(session.id, repositoryId, JSON.stringify(session));
    if (binding)
      this.db
        .prepare('INSERT INTO session_bindings VALUES (?,?)')
        .run(session.id, JSON.stringify(binding));
    return session;
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
  enqueue(taskId: string, mode: AuthMode, resumeSessionId?: string) {
    this.db
      .prepare(
        'INSERT INTO task_queue(task_id,resume_session_id,mode,enqueued_at) VALUES (?,?,?,?)',
      )
      .run(taskId, resumeSessionId ?? null, mode, new Date().toISOString());
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
  close() {
    if (this.db.isOpen) this.db.close();
  }
}
