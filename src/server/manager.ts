import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { AppError, messageOf } from './errors.js';
import { acquireLock } from './lock.js';
import { changedFiles, revalidateRepository } from './repositories.js';
import type { AgentProvider, ProviderSession } from './providers/types.js';
import type { Dashboard, TaskState } from '../shared/types.js';
import type { AuthMode } from '../shared/types.js';
import type { CodexAuth } from './providers/codex-auth.js';

interface Active {
  taskId: string;
  session?: ProviderSession;
  stopRequested: boolean;
  done: Promise<void>;
}
export class TaskManager {
  readonly events = new EventEmitter();
  private active?: Active;
  private closing = false;
  private connectionBusy = false;
  constructor(
    readonly store: Store,
    private provider: AgentProvider,
    private auth: CodexAuth,
    private secret?: string,
    private timeoutMs = 15 * 60_000,
  ) {}
  dashboard(): Dashboard {
    const task = this.active ? this.store.task(this.active.taskId) : undefined;
    return {
      connection: this.auth.view(),
      repositories: this.store.repositories(),
      tasks: this.store.tasks(),
      sessions: this.store.sessions(),
      agent: {
        id: 'codex-1',
        name: 'Codex 01',
        provider: this.provider.id,
        state: task?.state ?? 'idle',
        taskId: task?.id ?? null,
        canStop: this.provider.capabilities.cancellation,
        mode: 'Repository review · read only',
      },
      ready: !this.connectionBusy && this.auth.view().status === 'available',
      readinessMessage: this.auth.view().message,
    };
  }
  private clean<T>(value: T): T {
    let json = JSON.stringify(value);
    if (this.secret) json = json.split(this.secret).join('[REDACTED]');
    json = json.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
    return JSON.parse(json) as T;
  }
  private emit(taskId: string, kind: string, message: string, data?: unknown) {
    const clean = this.clean({ message: message.slice(0, 64_000), data });
    const encoded = JSON.stringify(clean.data);
    const event = this.store.addEvent(
      taskId,
      kind,
      clean.message,
      encoded && encoded.length > 64_000 ? { truncated: true } : clean.data,
    );
    this.events.emit('event', event);
  }
  start(taskId: string, resumeSessionId?: string) {
    if (this.closing) throw new AppError(503, 'Server is shutting down.');
    if (this.connectionBusy) throw new AppError(409, 'Wait for the connection check to finish.');
    if (!this.dashboard().ready) throw new AppError(503, this.dashboard().readinessMessage);
    if (this.active)
      throw new AppError(409, 'The agent already has a task. Stop it or wait for completion.');
    const task = this.store.task(taskId);
    if (!task) throw new AppError(404, 'Task not found.');
    if (task.state !== 'queued')
      throw new AppError(409, 'Create a new task to retry or continue a previous session.');
    const repository = this.store.repository(task.repositoryId);
    if (!repository) throw new AppError(404, 'Repository not found.');
    const previous = resumeSessionId ? this.store.session(resumeSessionId) : undefined;
    if (
      resumeSessionId &&
      (!previous?.threadId ||
        previous.repositoryId !== task.repositoryId ||
        previous.provider !== this.provider.id)
    )
      throw new AppError(400, 'Resume requires a saved thread from this repository and provider.');
    if (
      previous &&
      (!this.store.sessionBinding(previous.id) || previous.authMode !== this.auth.view().mode)
    )
      throw new AppError(
        409,
        'Choose the saved session’s connection mode. Legacy sessions without a verified connection context require a new session.',
      );
    const active: Active = { taskId, stopRequested: false, done: Promise.resolve() };
    this.active = active; // reserve synchronously, before any async filesystem work
    this.store.updateTask(taskId, { state: 'running' });
    this.emit(taskId, 'state', 'Starting repository review.');
    active.done = this.run(active, repository, previous?.id);
    return this.store.task(taskId)!;
  }
  private async run(
    active: Active,
    repository: NonNullable<ReturnType<Store['repository']>>,
    resumeId?: string,
  ) {
    let release: (() => Promise<void>) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let failure: string | null = null;
    let result = '';
    let eventCount = 0;
    let state: TaskState = 'failed';
    try {
      await revalidateRepository(repository);
      const locks = join(tmpdir(), `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
      await mkdir(locks, { recursive: true, mode: 0o700 });
      const hash = createHash('sha256').update(repository.gitDir).digest('hex');
      release = await acquireLock(join(locks, hash), repository.path);
      const baselineFiles = await changedFiles(repository.path);
      this.store.updateTask(active.taskId, { baselineFiles });
      if (active.stopRequested) {
        state = 'stopped';
        return;
      }
      const previous = resumeId ? this.store.session(resumeId)! : undefined;
      active.session = previous?.threadId
        ? await this.provider.resumeSession(
            repository.path,
            previous.threadId,
            this.store.sessionBinding(previous.id),
          )
        : await this.provider.startSession(repository.path);
      const saved =
        previous ??
        this.store.createSession(repository.id, active.session.binding, this.provider.id);
      this.store.updateTask(active.taskId, { sessionId: saved.id });
      if (active.stopRequested) {
        state = 'stopped';
        return;
      }
      await this.provider.executeTask(active.session, this.store.task(active.taskId)!.prompt);
      if (active.stopRequested) void this.provider.stopSession(active.session);
      timer = setTimeout(() => {
        failure = 'Task exceeded the 15 minute runtime limit.';
        void this.stop(active.taskId);
      }, this.timeoutMs);
      for await (const event of this.provider.streamEvents(active.session)) {
        if (++eventCount > 5000) {
          failure = 'Task exceeded the 5000 event limit.';
          void this.stop(active.taskId);
          continue;
        }
        if (event.kind === 'thread') this.store.setThread(saved.id, event.threadId);
        if (event.kind === 'result') {
          result = this.clean(event.text).slice(-256_000);
          this.store.updateTask(active.taskId, { result });
        }
        if (event.kind === 'failure' && !active.stopRequested) {
          failure ??= this.clean(event.message).slice(0, 64_000);
          this.auth.failure(event.category);
        }
        this.emit(
          active.taskId,
          event.kind,
          event.kind === 'thread'
            ? `Thread ${event.threadId}`
            : event.kind === 'result'
              ? event.text
              : event.message,
          event,
        );
      }
      state = failure ? 'failed' : active.stopRequested ? 'stopped' : 'completed';
    } catch (error) {
      failure = this.clean(messageOf(error)).slice(0, 64_000);
      state = active.stopRequested ? 'stopped' : 'failed';
      if (active.session) await this.provider.stopSession(active.session).catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
      if (active.session) await this.provider.stopSession(active.session).catch(() => {});
      try {
        if (release) {
          await revalidateRepository(repository);
          const files = await changedFiles(repository.path);
          this.store.updateTask(active.taskId, { changedFiles: files });
        }
      } catch (error) {
        this.store.updateTask(active.taskId, { summaryError: messageOf(error).slice(0, 1000) });
      }
      try {
        await release?.();
      } catch {
        state = 'failed';
        failure ??=
          'Could not release the repository lease. Inspect its lock directory before retrying.';
      }
      this.store.updateTask(active.taskId, { state, result, error: failure });
      this.active = undefined;
      this.emit(active.taskId, 'state', failure ?? `Task ${state}.`);
    }
  }
  async stop(taskId: string) {
    const active = this.active;
    if (!active || active.taskId !== taskId) throw new AppError(409, 'This task is not active.');
    if (!this.provider.capabilities.cancellation)
      throw new AppError(409, 'This provider does not support cancellation.');
    if (!active.stopRequested) {
      active.stopRequested = true;
      this.store.updateTask(taskId, { state: 'stopping' });
      this.emit(taskId, 'state', 'Stopping agent and cleaning up its process group.');
      if (active.session) await this.provider.stopSession(active.session);
    }
    await active.done;
  }
  async shutdown() {
    this.closing = true;
    if (this.active) await this.stop(this.active.taskId);
  }
  async selectConnection(mode: AuthMode) {
    if (this.active || this.closing || this.connectionBusy)
      throw new AppError(
        409,
        'Stop the active agent or wait for the connection check before changing its connection.',
      );
    this.connectionBusy = true;
    try {
      return await this.auth.select(mode);
    } finally {
      this.connectionBusy = false;
    }
  }
  async refreshConnection() {
    if (this.active || this.closing || this.connectionBusy)
      throw new AppError(
        409,
        'Wait for the active agent or connection check to finish before refreshing.',
      );
    this.connectionBusy = true;
    try {
      return await this.auth.refresh();
    } finally {
      this.connectionBusy = false;
    }
  }
}
