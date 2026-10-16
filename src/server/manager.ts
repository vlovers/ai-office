import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './store.js';
import { AppError } from './errors.js';
import { acquireLock, ResourceLockedError } from './lock.js';
import { changedFiles, revalidateRepository } from './repositories.js';
import type { AgentProvider, ProviderSession } from './providers/types.js';
import {
  AGENT_IDS,
  type AgentId,
  type Dashboard,
  type TaskState,
  type QueueEntry,
} from '../shared/types.js';
import type { AuthMode } from '../shared/types.js';
import type { CodexAuth } from './providers/codex-auth.js';

interface Active {
  taskId: string;
  agentId: AgentId;
  gitDir: string;
  preparing: boolean;
  preserveQueue?: boolean;
  session?: ProviderSession;
  stopRequested: boolean;
  done: Promise<void>;
}
export class TaskManager {
  readonly events = new EventEmitter();
  private active = new Map<AgentId, Active>();
  private timer?: NodeJS.Timeout;
  private waiting = new Map<string, string>();
  private providers: Map<AgentId, AgentProvider>;
  private closing = false;
  private connectionBusy = false;
  constructor(
    readonly store: Store,
    providers: AgentProvider | readonly AgentProvider[],
    private auth: CodexAuth,
    private secret?: string,
    private timeoutMs = 15 * 60_000,
  ) {
    const list = Array.isArray(providers) ? providers : [providers as AgentProvider];
    if (list.length < 1 || list.length > 2 || new Set(list).size !== list.length)
      throw new Error('Provide one or two independent agent providers.');
    this.providers = new Map(list.map((provider, index) => [AGENT_IDS[index]!, provider]));
  }
  startQueue() {
    this.wake(0);
  } // recover submitted work only after a successful listen
  dashboard(): Dashboard {
    const queue = this.store.queue();
    const agents = [...this.providers].map(([id, provider]) => {
      const active = this.active.get(id);
      const task = active ? this.store.task(active.taskId) : undefined;
      const queued = queue.find((entry) => entry.agentId === id);
      return {
        id,
        name: `Codex ${id === 'codex-1' ? '01' : '02'}`,
        provider: provider.id,
        state: active
          ? active.preparing && task?.state !== 'stopping'
            ? 'preparing'
            : (task?.state ?? 'idle')
          : queued
            ? 'waiting'
            : 'idle',
        taskId: task?.id ?? null,
        canStop: provider.capabilities.cancellation,
        mode: 'Repository review · read only',
      };
    });
    return {
      connection: this.auth.view(),
      repositories: this.store.repositories(),
      tasks: this.store.tasks(),
      sessions: this.store.sessions(),
      agents,
      agent: agents[0]!,
      concurrency: this.providers.size,
      queue: queue.map((entry) => ({
        ...entry,
        waitingReason:
          this.waiting.get(entry.taskId) ??
          (entry.mode !== this.auth.view().mode
            ? 'Choose the submitted connection mode.'
            : 'Waiting for assigned agent.'),
      })),
      ready: !this.connectionBusy && this.auth.view().status === 'available',
      readinessMessage: this.auth.view().message,
    };
  }
  private wake(delay = 200) {
    if (this.closing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
    this.timer.unref();
  }
  private pump() {
    if (this.closing) return;
    if (this.connectionBusy || this.auth.view().status !== 'available') {
      if (this.store.queue().length) this.wake(1000);
      return;
    }
    const queue = this.store.queue();
    for (const [agentId] of this.providers) {
      if (this.active.has(agentId)) continue;
      const entry = queue.find((item) => item.agentId === agentId);
      if (!entry || entry.mode !== this.auth.view().mode) continue;
      const task = this.store.task(entry.taskId);
      const repository = task && this.store.repository(task.repositoryId);
      if (!task || task.state !== 'queued' || !repository) {
        this.store.removeQueued(entry.taskId);
        continue;
      }
      if ([...this.active.values()].some((run) => run.gitDir === repository.gitDir)) {
        this.waiting.set(task.id, 'Worktree busy; waiting for its lease.');
        continue;
      }
      const active: Active = {
        taskId: task.id,
        agentId,
        gitDir: repository.gitDir,
        preparing: true,
        stopRequested: false,
        done: Promise.resolve(),
      };
      this.active.set(agentId, active); // reserve before asynchronous validation/lease acquisition
      active.done = this.run(active, repository, entry);
    }
    if (this.store.queue().length) this.wake(500);
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
    const task = this.store.task(taskId);
    if (!task) throw new AppError(404, 'Task not found.');
    if (task.state !== 'queued')
      throw new AppError(409, 'Create a new task to retry or continue a previous session.');
    const provider = this.providers.get(task.agentId);
    if (!provider) throw new AppError(400, 'Unknown assigned agent.');
    if (this.store.queue().some((entry) => entry.taskId === task.id))
      throw new AppError(409, 'Task is already submitted to the queue.');
    if (this.store.queue().length >= 100)
      throw new AppError(409, 'Queue limit is 100 submitted tasks.');
    const repository = this.store.repository(task.repositoryId);
    if (!repository) throw new AppError(404, 'Repository not found.');
    const previous = this.validateResume(task, resumeSessionId);
    this.store.enqueue(taskId, this.auth.view().mode, previous?.id);
    this.emit(taskId, 'queue', 'Submitted to the assigned agent queue.');
    this.pump();
    return this.store.task(taskId)!;
  }
  private validateResume(task: NonNullable<ReturnType<Store['task']>>, resumeSessionId?: string) {
    const provider = this.providers.get(task.agentId)!;
    const previous = resumeSessionId ? this.store.session(resumeSessionId) : undefined;
    if (
      resumeSessionId &&
      (!previous?.threadId ||
        previous.repositoryId !== task.repositoryId ||
        previous.provider !== provider.id ||
        previous.agentId !== task.agentId)
    )
      throw new AppError(
        400,
        'Resume requires a saved thread from this repository, provider and assigned agent.',
      );
    if (
      previous &&
      (!this.store.sessionBinding(previous.id) || previous.authMode !== this.auth.view().mode)
    )
      throw new AppError(
        409,
        'Choose the saved session’s connection mode. Legacy sessions without a verified connection context require a new session.',
      );
    return previous;
  }
  private async run(
    active: Active,
    repository: NonNullable<ReturnType<Store['repository']>>,
    entry: QueueEntry,
  ) {
    let release: (() => Promise<void>) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let failure: string | null = null;
    let result = '';
    let eventCount = 0;
    let state: TaskState = 'failed';
    let requeue = false;
    const provider = this.providers.get(active.agentId)!;
    try {
      await revalidateRepository(repository);
      if (active.stopRequested || this.closing) {
        state = 'stopped';
        return;
      }
      // A fixed OS-local root ensures TMPDIR differences cannot bypass another process's lease.
      const locks = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
      await mkdir(locks, { recursive: true, mode: 0o700 });
      const hash = createHash('sha256').update(repository.gitDir).digest('hex');
      release = await acquireLock(join(locks, hash), repository.path);
      if (active.stopRequested || this.closing) {
        state = 'stopped';
        return;
      }
      this.validateResume(this.store.task(active.taskId)!, entry.resumeSessionId ?? undefined);
      this.store.claimQueued(active.taskId);
      this.waiting.delete(active.taskId);
      this.emit(active.taskId, 'state', 'Starting repository review.');
      const baselineFiles = await changedFiles(repository.path);
      this.store.updateTask(active.taskId, { baselineFiles });
      if (active.stopRequested) {
        state = 'stopped';
        return;
      }
      const previous = entry.resumeSessionId
        ? this.store.session(entry.resumeSessionId)!
        : undefined;
      active.session = previous?.threadId
        ? await provider.resumeSession(
            repository.path,
            previous.threadId,
            this.store.sessionBinding(previous.id),
          )
        : await provider.startSession(repository.path);
      const saved =
        previous ??
        this.store.createSession(
          repository.id,
          active.session.binding,
          provider.id,
          active.agentId,
        );
      this.store.updateTask(active.taskId, { sessionId: saved.id });
      if (active.stopRequested) {
        state = 'stopped';
        return;
      }
      await provider.executeTask(active.session, this.store.task(active.taskId)!.prompt);
      if (active.stopRequested) void provider.stopSession(active.session);
      timer = setTimeout(() => {
        failure = 'Task exceeded the 15 minute runtime limit.';
        void this.stop(active.taskId);
      }, this.timeoutMs);
      for await (const event of provider.streamEvents(active.session)) {
        active.preparing = false;
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
      if (error instanceof ResourceLockedError && !active.stopRequested) {
        requeue = true;
        this.waiting.set(active.taskId, 'Worktree busy; waiting for its lease.');
      } else {
        failure =
          error instanceof AppError
            ? this.clean(error.message).slice(0, 64_000)
            : 'Could not prepare or finish this task. Runtime diagnostics were withheld to protect private metadata.';
        state = active.stopRequested ? 'stopped' : 'failed';
        if (active.session) await provider.stopSession(active.session).catch(() => {});
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (active.session) await provider.stopSession(active.session).catch(() => {});
      try {
        if (release) {
          await revalidateRepository(repository);
          const files = await changedFiles(repository.path);
          this.store.updateTask(active.taskId, { changedFiles: files });
        }
      } catch (error) {
        this.store.updateTask(active.taskId, {
          summaryError:
            error instanceof AppError
              ? error.message.slice(0, 1000)
              : 'Worktree summary unavailable. Private runtime diagnostics were withheld.',
        });
      }
      try {
        await release?.();
      } catch {
        state = 'failed';
        failure ??=
          'Could not release the repository lease. Inspect its lock directory before retrying.';
      }
      if (!requeue && !active.preserveQueue) {
        this.store.removeQueued(active.taskId);
        this.waiting.delete(active.taskId);
        this.store.updateTask(active.taskId, { state, result, error: failure });
      }
      this.active.delete(active.agentId);
      if (!requeue && !active.preserveQueue)
        this.emit(active.taskId, 'state', failure ?? `Task ${state}.`);
      this.wake();
    }
  }
  async stop(taskId: string) {
    const active = [...this.active.values()].find((run) => run.taskId === taskId);
    if (!active) {
      if (!this.store.queue().some((entry) => entry.taskId === taskId))
        throw new AppError(409, 'This task is not active or submitted.');
      this.store.removeQueued(taskId);
      this.waiting.delete(taskId);
      this.store.updateTask(taskId, { state: 'stopped' });
      this.emit(taskId, 'state', 'Task stopped before execution.');
      this.wake();
      return;
    }
    const provider = this.providers.get(active.agentId)!;
    if (!provider.capabilities.cancellation)
      throw new AppError(409, 'This provider does not support cancellation.');
    if (!active.stopRequested) {
      active.stopRequested = true;
      this.store.removeQueued(taskId);
      this.store.updateTask(taskId, { state: 'stopping' });
      this.emit(taskId, 'state', 'Stopping agent and cleaning up its process group.');
      if (active.session) await provider.stopSession(active.session);
    }
    await active.done;
  }
  async shutdown() {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all(
      [...this.active.values()].map(async (active) => {
        if (this.store.task(active.taskId)?.state === 'queued') {
          active.preserveQueue = true;
          active.stopRequested = true;
          await active.done;
        } else await this.stop(active.taskId);
      }),
    );
  }
  async selectConnection(mode: AuthMode) {
    if (this.active.size || this.closing || this.connectionBusy)
      throw new AppError(
        409,
        'Stop the active agent or wait for the connection check before changing its connection.',
      );
    this.connectionBusy = true;
    try {
      return await this.auth.select(mode);
    } finally {
      this.connectionBusy = false;
      this.wake(0);
    }
  }
  async refreshConnection() {
    if (this.active.size || this.closing || this.connectionBusy)
      throw new AppError(
        409,
        'Wait for the active agent or connection check to finish before refreshing.',
      );
    this.connectionBusy = true;
    try {
      return await this.auth.refresh();
    } finally {
      this.connectionBusy = false;
      this.wake(0);
    }
  }
}
