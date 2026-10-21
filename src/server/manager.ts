import { assertConfiguration, configuredPrompt } from './execution-config.js';
import { agentIdSchema, validateAgentSettings } from './agents.js';
import { diffLines } from '../shared/diff.js';
import type { ReviewComment, ReviewRecord } from '../shared/types.js';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { UncertainCleanupError } from './process-group.js';
import { Workspaces } from './workspaces.js';
import {
  stageReviewerGitContext,
  removeReviewerGitContext,
  verifyReviewerGitContext,
} from './reviewer-runtime.js';
import {
  createReviewerSourceCandidate,
  verifyReviewerSourceCandidate,
  type ReviewerSourceManifest,
} from './reviewer-source.js';
import {
  materializeEvidenceBundle,
  removeEvidenceBundle,
  verifyEvidenceBundle,
  type SnapshotManifest,
} from './evidence-bundle.js';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { WorkflowStore } from './workflows.js';
import { AppError } from './errors.js';
import { acquireLocks, acquireLock, ResourceLockedError } from './lock.js';
import { changedFiles, revalidateRepository, repositoryLeaseDirectories } from './repositories.js';
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

export interface FeedbackInput {
  revision: string;
  version: number;
  comments: ReviewComment[];
}
interface Active {
  taskId: string;
  agentId: AgentId;
  gitDir: string;
  preparing: boolean;
  quarantined?: boolean;
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
  private shutdownController = new AbortController();
  private reviews = new Set<Promise<unknown>>();
  private connectionBusy = false;
  constructor(
    readonly store: Store,
    providers: AgentProvider | readonly AgentProvider[],
    private auth: CodexAuth,
    private secret?: string,
    private timeoutMs = 15 * 60_000,
    readonly workspaces?: Workspaces,
    private runtime?: { createProvider: (id: AgentId) => AgentProvider; concurrency?: 1 | 2 },
  ) {
    const list = Array.isArray(providers) ? providers : [providers as AgentProvider];
    if (list.length < 1 || list.length > 2 || new Set(list).size !== list.length)
      throw new Error('Provide one or two independent agent providers.');
    if (runtime?.concurrency !== undefined && ![1, 2].includes(runtime.concurrency))
      throw new Error('Concurrency must be one or two.');
    this.providers = new Map(list.map((provider, index) => [AGENT_IDS[index]!, provider]));
  }
  private providerFor(id: AgentId) {
    if (!agentIdSchema.safeParse(id).success || !this.store.agent(id))
      throw new AppError(400, 'Unknown assigned agent.');
    let provider = this.providers.get(id);
    if (!provider && this.runtime) {
      provider = this.runtime.createProvider(id);
      if (provider.id !== 'codex' || [...this.providers.values()].includes(provider))
        throw new Error('Agent profiles require independent Codex providers.');
      this.providers.set(id, provider);
    }
    return provider;
  }
  private capacity() {
    return this.runtime?.concurrency ?? (this.runtime ? 2 : this.providers.size);
  }
  agentSettings(input: unknown) {
    return validateAgentSettings(input, this.secret);
  }
  startQueue() {
    this.wake(0);
  } // recover submitted work only after a successful listen
  dashboard(): Dashboard {
    const queue = this.store.queue();
    const agents = this.store
      .agents()
      .filter((profile) => this.runtime || this.providers.has(profile.id))
      .map((profile) => {
        const id = profile.id;
        const provider = this.providers.get(id);
        const active = this.active.get(id);
        const task = active ? this.store.task(active.taskId) : undefined;
        const queued = queue.find((entry) => entry.agentId === id);
        return {
          id,
          name: profile.name,
          provider: profile.provider,
          state: active
            ? active.preparing && task?.state !== 'stopping'
              ? 'preparing'
              : (task?.state ?? 'idle')
            : queued
              ? 'waiting'
              : 'idle',
          taskId: task?.id ?? null,
          canStop: !active?.quarantined && (provider?.capabilities.cancellation ?? true),
          mode:
            task?.executionMode === 'write'
              ? 'Isolated coding · write enabled'
              : 'Repository review · read only',
        };
      });
    return {
      profiles: this.store.agents(),
      connection: this.auth.view(),
      repositories: this.store.repositories(),
      tasks: this.store
        .tasks()
        .map((task) => ({ ...task, configuration: this.store.taskConfiguration(task.id) })),
      sessions: this.store.sessions().map((session) => ({
        ...session,
        configuration: this.store.sessionConfiguration(session.id),
      })),
      agents,
      agent: agents[0]!,
      concurrency: this.capacity(),
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
    const visited = new Set<AgentId>();
    for (const entry of queue) {
      if (this.active.size >= this.capacity()) break;
      const agentId = entry.agentId;
      if (visited.has(agentId)) continue;
      visited.add(agentId); // preserve FIFO even if this profile's head is blocked
      if (this.active.has(agentId) || entry.mode !== this.auth.view().mode) continue;
      if (!this.providerFor(agentId)) continue;
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
  start(
    taskId: string,
    resumeSessionId?: string,
    confirmedWrite = false,
    workflow?: { id: string; version: number; revision: string },
  ) {
    if (this.closing) throw new AppError(503, 'Server is shutting down.');
    if (this.connectionBusy) throw new AppError(409, 'Wait for the connection check to finish.');
    if (!this.dashboard().ready) throw new AppError(503, this.dashboard().readinessMessage);
    const task = this.store.task(taskId);
    if (!task) throw new AppError(404, 'Task not found.');
    if (task.state !== 'queued')
      throw new AppError(409, 'Create a new task to retry or continue a previous session.');
    if (task.executionMode === 'write' && (!confirmedWrite || !this.workspaces))
      throw new AppError(
        409,
        'Confirm isolated writes and configure AI_OFFICE_AUTHORIZED_ROOT and AI_OFFICE_WORKSPACE_ROOT first.',
      );
    const provider = this.providerFor(task.agentId);
    if (!provider) throw new AppError(400, 'Unknown assigned agent.');
    if (task.executionMode === 'write' && !provider.capabilities.writes)
      throw new AppError(409, 'Provider does not support isolated writes.');
    if (this.store.queue().some((entry) => entry.taskId === task.id))
      throw new AppError(409, 'Task is already submitted to the queue.');
    if (this.store.queue().length >= 100)
      throw new AppError(409, 'Queue limit is 100 submitted tasks.');
    const repository = this.store.repository(task.repositoryId);
    if (!repository) throw new AppError(404, 'Repository not found.');
    if (this.store.requireAgent(task.agentId).archived && !task.reviewRequest)
      throw new AppError(409, 'Restore the archived agent before submitting new work.');
    const previous = this.validateResume(task, resumeSessionId);
    const workflows = new WorkflowStore(this.store.db);
    const bound = workflows.list().find((w) => w.stages.some((s) => s.taskId === taskId));
    if (bound && (!workflow || workflow.id !== bound.id))
      throw new AppError(409, 'Workflow-bound tasks must use the approved workflow submission.');
    if (workflow) {
      if (resumeSessionId || !bound || workflow.id !== bound.id)
        throw new AppError(409, 'Invalid workflow submission.');
      // Reviewer/QA must never silently run against the repository HEAD.
      // Their input is a reviewed worktree content fingerprint, not a commit.
      // A dedicated leased, read-only snapshot runner is required first.
      if (bound.stages[0]?.taskId !== taskId || bound.stages[0]?.kind !== 'coder')
        throw new AppError(409, 'Reviewer/QA execution requires verified read-only handoff.');
      workflows.enqueueApprovedTask(
        this.store,
        workflow.id,
        workflow.version,
        taskId,
        this.auth.view().mode,
        workflow.revision,
      );
    } else {
      this.store.enqueue(taskId, this.auth.view().mode, previous?.id);
    }
    this.emit(taskId, 'queue', 'Submitted to the assigned agent queue.');
    this.pump();
    return this.store.task(taskId)!;
  }
  private validateResume(task: NonNullable<ReturnType<Store['task']>>, resumeSessionId?: string) {
    const provider = this.providerFor(task.agentId)!;
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
    if (previous && (previous.executionMode ?? 'read-only') !== (task.executionMode ?? 'read-only'))
      throw new AppError(409, 'Resume requires the same execution mode.');
    if (previous?.executionMode === 'write' && !previous.workspaceId)
      throw new AppError(
        409,
        'Saved write session has no workspace identity. Start a new session.',
      );
    if (previous?.workspaceId && this.store.workspace(previous.workspaceId)?.decision !== 'pending')
      throw new AppError(409, 'Only pending workspaces can be resumed.');
    if (previous) assertConfiguration(this.store.sessionConfiguration(previous.id), task);
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
    let workingPath = repository.path;
    let workspaceRelease: (() => Promise<void>) | undefined;
    let cleanupConfirmed = true;
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
      const directories = await repositoryLeaseDirectories(repository);
      const lockPaths = directories.map((directory) =>
        join(locks, createHash('sha256').update(directory).digest('hex')),
      );
      release = await acquireLocks(lockPaths, repository.path);
      if (active.stopRequested || this.closing) {
        state = 'stopped';
        return;
      }
      this.validateResume(this.store.task(active.taskId)!, entry.resumeSessionId ?? undefined);
      const queuedConfiguration = assertConfiguration(
        this.store.taskConfiguration(active.taskId),
        this.store.task(active.taskId)!,
      );
      if (entry.mode === 'api-key' && queuedConfiguration.model === null)
        throw new AppError(
          409,
          'Saved API-key submission has no explicit model. Preserve its history and create a new task with a configured model; no replacement session was started.',
        );
      this.store.claimQueued(active.taskId);
      this.waiting.delete(active.taskId);
      const task = this.store.task(active.taskId)!;
      if (task.executionMode === 'write') {
        if (!this.workspaces) throw new AppError(409, 'Isolated writes are not configured.');
        const previousSession = entry.resumeSessionId
          ? this.store.session(entry.resumeSessionId)
          : undefined;
        const workspaceId = previousSession?.workspaceId ?? task.workspaceId;
        const workspace = workspaceId ? this.store.workspace(workspaceId) : undefined;
        if (workspaceId && !workspace)
          throw new AppError(409, 'Saved workspace metadata is missing.');
        const isolated =
          workspace ??
          (await this.workspaces.create(repository, randomUUID(), (intent) =>
            this.store.attachWorkspace(active.taskId, intent),
          ));
        if (isolated.decision !== 'pending')
          throw new AppError(409, 'Workspace is no longer pending review.');
        await this.workspaces.validateExecution(repository, isolated);
        this.store.attachWorkspace(active.taskId, isolated);
        if (!directories.includes(isolated.gitDir))
          workspaceRelease = await acquireLock(
            join(locks, createHash('sha256').update(isolated.gitDir).digest('hex')),
            isolated.path,
          );
        workingPath = isolated.path;
        this.emit(active.taskId, 'workspace', `Isolated branch ${isolated.branch} ready.`);
      }
      this.emit(active.taskId, 'state', 'Starting agent session.');
      const baselineFiles = await changedFiles(workingPath);
      this.store.updateTask(active.taskId, { baselineFiles });
      if (active.stopRequested) {
        state = 'stopped';
        return;
      }
      const previous = entry.resumeSessionId
        ? this.store.session(entry.resumeSessionId)!
        : undefined;
      const pinned = assertConfiguration(this.store.taskConfiguration(task.id), task);
      if (
        previous &&
        JSON.stringify(this.store.sessionConfiguration(previous.id)) !== JSON.stringify(pinned)
      )
        throw new AppError(
          409,
          'Pinned session configuration changed. No replacement session was started.',
        );
      active.session = previous?.threadId
        ? await provider.resumeSession(
            workingPath,
            previous.threadId,
            this.store.sessionBinding(previous.id),
          )
        : await provider.startSession(workingPath, pinned.model);
      const effective = { ...pinned, model: active.session.binding?.model ?? null };
      if (pinned.model !== null && effective.model !== pinned.model)
        throw new AppError(
          409,
          'Provider did not preserve the pinned model. No execution was started.',
        );
      if (
        previous &&
        JSON.stringify(active.session.binding) !==
          JSON.stringify(this.store.sessionBinding(previous.id))
      )
        throw new AppError(
          409,
          'Provider did not preserve the saved connection binding. No execution was started.',
        );
      const saved =
        previous ??
        this.store.createSession(
          repository.id,
          active.session.binding,
          provider.id,
          active.agentId,
          this.store.task(active.taskId)!.executionMode,
          this.store.task(active.taskId)!.workspaceId,
          effective,
        );
      this.store.effectiveConfiguration(active.taskId, effective);
      this.store.updateTask(active.taskId, { sessionId: saved.id });
      if (active.stopRequested) {
        state = 'stopped';
        return;
      }
      const currentTask = this.store.task(active.taskId)!;
      await revalidateRepository(repository);
      if (currentTask.workspaceId && this.workspaces)
        await this.workspaces.validateExecution(
          repository,
          this.store.workspace(currentTask.workspaceId)!,
        );
      if (currentTask.reviewRequest) {
        const request = currentTask.reviewRequest;
        const currentSession = this.validateResume(currentTask, request.sessionId);
        if (
          currentSession?.threadId !== request.threadId ||
          currentSession.workspaceId !== currentTask.workspaceId ||
          JSON.stringify(this.store.sessionBinding(request.sessionId)) !==
            JSON.stringify(active.session.binding) ||
          previous?.id !== request.sessionId ||
          previous?.threadId !== request.threadId ||
          active.session.threadId !== request.threadId
        )
          throw new AppError(
            409,
            'Review continuation session identity changed. No replacement thread was started.',
          );
        await this.workspaces!.assertRevision(
          repository,
          this.store.workspace(currentTask.workspaceId!)!,
          request.revision,
        );
      }
      active.session.executionMode = currentTask.executionMode ?? 'read-only';
      await provider.executeTask(
        active.session,
        configuredPrompt(effective, this.store.task(active.taskId)!.prompt),
      );
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
        if (event.kind === 'thread') {
          if (previous?.threadId && event.threadId !== previous.threadId)
            throw new AppError(
              409,
              'Codex returned a different thread during resume. Stopped; inspect the native session before continuing.',
            );
          this.store.setThread(saved.id, event.threadId);
        }
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
      if (
        error instanceof ResourceLockedError &&
        !active.stopRequested &&
        this.store.task(active.taskId)?.state === 'queued'
      ) {
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
      if (active.session) {
        try {
          await provider.stopSession(active.session);
        } catch {
          cleanupConfirmed = false;
          active.quarantined = true;
          state = 'interrupted';
          failure = new UncertainCleanupError().message;
        }
      }
      try {
        if (release) {
          await revalidateRepository(repository);
          const files = await changedFiles(workingPath);
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
      if (!requeue && !active.preserveQueue && this.store.task(active.taskId)?.workspaceId) {
        const workspace = this.store.workspace(this.store.task(active.taskId)!.workspaceId!);
        if (workspace) this.store.saveWorkspace({ ...workspace, reviewEpoch: active.taskId });
      }
      try {
        if (cleanupConfirmed) {
          await workspaceRelease?.();
          await release?.();
        }
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
      if (!requeue && !active.preserveQueue) {
        // A task ending does not validate its Git result. Block any workflow
        // handoff until its output is independently inspected and approved.
        new WorkflowStore(this.store.db).reconcileTerminals();
      }
      if (cleanupConfirmed) this.active.delete(active.agentId);
      if (!requeue && !active.preserveQueue)
        this.emit(active.taskId, 'state', failure ?? `Task ${state}.`);
      this.wake();
    }
  }
  reviewHistory(taskId: string, before?: number) {
    const task = this.store.task(taskId);
    if (!task?.workspaceId) throw new AppError(404, 'Workspace not found.');
    return this.clean(
      this.store.reviewRecords(task.workspaceId, before).map((record) => {
        const next = record.continuationTaskId
          ? this.store.task(record.continuationTaskId)
          : undefined;
        return {
          ...record,
          configuration:
            record.configuration ??
            (record.sessionId ? this.store.sessionConfiguration(record.sessionId) : undefined),
          continuation: next
            ? { id: next.id, state: next.state, error: next.error, sessionId: next.sessionId }
            : undefined,
        };
      }),
    );
  }
  private saveFeedback(taskId: string, input: FeedbackInput) {
    const task = this.store.task(taskId)!;
    const record = this.store.reviewRecord(task.workspaceId!, input.revision);
    if (!record) throw new AppError(404, 'Review revision not found. Refresh Git review.');
    if (record.submittedAt)
      throw new AppError(409, 'Submitted feedback is immutable. Review the next revision.');
    if (record.version !== input.version)
      throw new AppError(409, 'Feedback changed. Reload review history before editing.');
    const ids = new Set<string>();
    const now = new Date().toISOString();
    const comments = input.comments.map((comment) => {
      if (ids.has(comment.id)) throw new AppError(400, 'Duplicate comment identifier.');
      ids.add(comment.id);
      const file = record.files.find((file) => file.path === comment.path);
      if (comment.path && !file) throw new AppError(400, 'Comment file is not in this revision.');
      if (
        comment.anchor &&
        (!file?.patch ||
          !diffLines(file.patch).some(
            (line) => line[comment.anchor!.side] === comment.anchor!.line,
          ))
      )
        throw new AppError(400, 'Line anchor is not in this revision.');
      const previous = record.comments.find((item) => item.id === comment.id);
      return {
        ...comment,
        createdAt: previous?.createdAt ?? now,
        updatedAt:
          previous &&
          JSON.stringify({ ...previous, updatedAt: '' }) ===
            JSON.stringify({ ...comment, createdAt: previous.createdAt, updatedAt: '' })
            ? previous.updatedAt
            : now,
      };
    });
    return this.store.saveComments(record, this.clean(comments));
  }
  /**
   * This creates an evidence bundle, NOT a runnable immutable worktree.
   * The lease covers the entire review + capture + provenance transaction.
   */
  async captureWorkflowBundle(workflowId: string, version: number, revision: string) {
    if (this.closing || !this.workspaces)
      throw new AppError(503, 'Snapshot capture is unavailable.');
    const workflow = new WorkflowStore(this.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    if (
      !workflow ||
      workflow.version !== version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      !coder.taskId ||
      coder.evidence?.revision !== revision ||
      reviewer?.state !== 'ready' ||
      reviewer.approvedRevision !== revision ||
      reviewer.bundle
    )
      throw new AppError(409, 'Reviewer handoff is not approved or is stale.');
    const task = this.store.task(coder.taskId);
    const repository = this.store.repository(workflow.repositoryId);
    const workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    if (
      !task ||
      task.state !== 'completed' ||
      !repository ||
      !workspace ||
      workspace.id !== coder.evidence.workspaceId ||
      task.repositoryId !== repository.id
    )
      throw new AppError(409, 'Coder task and workspace binding changed.');
    const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockPaths = (await repositoryLeaseDirectories(repository, workspace.gitDir)).map(
      (directory) => join(lockRoot, createHash('sha256').update(directory).digest('hex')),
    );
    let release: () => Promise<void>;
    try {
      release = await acquireLocks(lockPaths, repository.path);
    } catch {
      throw new AppError(409, 'Repository is busy or has an unresolved lease.');
    }
    try {
      await this.workspaces.validate(repository, workspace);
      const review = await this.workspaces.review(repository, workspace);
      if (review.revision !== revision || review.files.length !== coder.evidence.fileCount)
        throw new AppError(409, 'Coder evidence changed before bundle capture.');
      if ([...this.active.values()].some((run) => run.gitDir === repository.gitDir))
        throw new AppError(409, 'Active agent is using the repository.');
      const authorizedRoot = await this.workspaces.authorize(repository);
      const destinationRoot = join(authorizedRoot, 'workflow-evidence');
      await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
      const bundle = await materializeEvidenceBundle({
        workspacePath: workspace.path,
        destinationRoot,
        files: review.files,
        evidenceRevision: revision,
        verifyRevision: () => this.workspaces!.revision(repository, workspace),
      });
      try {
        const saved = new WorkflowStore(this.store.db).recordReviewerBundle(
          workflowId,
          version,
          revision,
          {
            directory: bundle.path,
            digest: bundle.manifest.digest,
            id: bundle.manifest.id,
            fileCount: bundle.manifest.entries.length,
          },
        );
        return { workflow: saved, manifest: bundle.manifest, runnable: false };
      } catch (error) {
        await removeEvidenceBundle(destinationRoot, bundle.path);
        throw error;
      }
    } finally {
      await release();
    }
  }

  /**
   * Revalidates a recorded bundle without permitting downstream execution.
   * Untrusted bundles never become permission grants.
   */
  /**
   * Creates a full source candidate only after the evidence checkpoint.
   * Neither the checkpoint nor a source candidate grants execution authority.
   */
  async prepareReviewerSource(workflowId: string, version: number) {
    if (this.closing || !this.workspaces)
      throw new AppError(503, 'Reviewer source preparation is unavailable.');
    const workflow = new WorkflowStore(this.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    if (
      !workflow ||
      workflow.version !== version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      reviewer?.state !== 'ready' ||
      !reviewer.bundle ||
      reviewer.sourceCandidate ||
      reviewer.approvedRevision !== reviewer.bundle.revision ||
      coder.evidence?.revision !== reviewer.bundle.revision
    )
      throw new AppError(409, 'Approved Reviewer source checkpoint is unavailable.');
    const task = coder.taskId ? this.store.task(coder.taskId) : undefined;
    const repository = this.store.repository(workflow.repositoryId);
    const workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    if (
      !task ||
      task.state !== 'completed' ||
      !repository ||
      !workspace ||
      workspace.id !== coder.evidence?.workspaceId ||
      task.repositoryId !== repository.id
    )
      throw new AppError(409, 'Coder workspace no longer matches the approved evidence.');
    const root = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const paths = (await repositoryLeaseDirectories(repository, workspace.gitDir)).map(
      (directory) => join(root, createHash('sha256').update(directory).digest('hex')),
    );
    const release = await acquireLocks(paths, repository.path);
    try {
      await this.workspaces.validate(repository, workspace);
      if ([...this.active.values()].some((run) => run.gitDir === repository.gitDir))
        throw new AppError(409, 'Agent still active in repository.');
      const revision = await this.workspaces.revision(repository, workspace);
      if (revision !== reviewer.bundle.revision)
        throw new AppError(409, 'Coder revision changed after evidence approval.');
      const evidenceRoot = join(await this.workspaces.authorize(repository), 'workflow-evidence');
      if (reviewer.bundle.directory !== join(evidenceRoot, reviewer.bundle.id))
        throw new AppError(409, 'Evidence provenance path changed.');
      let validEvidence = false;
      try {
        const raw = await readFile(join(reviewer.bundle.directory, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(raw) as SnapshotManifest;
        validEvidence =
          manifest.id === reviewer.bundle.id &&
          manifest.digest === reviewer.bundle.digest &&
          manifest.evidenceRevision === revision &&
          Array.isArray(manifest.entries) &&
          manifest.entries.length === reviewer.bundle.fileCount &&
          (await verifyEvidenceBundle(reviewer.bundle.directory, manifest));
      } catch {
        // Fail closed on corrupted, missing or inaccessible evidence.
      }
      if (!validEvidence) throw new AppError(409, 'Evidence bundle failed integrity validation.');
      const snapshotRoot = join(
        await this.workspaces.authorize(repository),
        'workflow-reviewer-source',
      );
      await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
      const candidate = await createReviewerSourceCandidate({
        workspace: workspace.path,
        destinationRoot: snapshotRoot,
        revision,
        verifyRevision: () => this.workspaces!.revision(repository, workspace),
      });
      try {
        if (!(await verifyReviewerSourceCandidate(candidate.directory, candidate.manifest)))
          throw new AppError(409, 'Reviewer source candidate failed verification.');
        const saved = new WorkflowStore(this.store.db).recordReviewerSource(
          workflowId,
          version,
          revision,
          {
            directory: candidate.directory,
            digest: candidate.manifest.digest,
            fileCount: candidate.manifest.files.length,
          },
        );
        return {
          workflow: saved,
          sourceManifest: candidate.manifest,
          verified: true,
          runnable: false,
        };
      } catch (error) {
        await removeEvidenceBundle(snapshotRoot, candidate.directory);
        throw error;
      }
    } finally {
      await release();
    }
  }

  /**
   * Recheck durable full-source provenance. Never returns execution approval.
   * This is deliberately a separate check from evidence-bundle integrity.
   */
  /** Stages a separate Git repository; does not start Codex or grant execution. */
  /** Verify an already persisted runtime before any future Reviewer dispatch. */
  async verifyPreparedReviewerRuntime(workflowId: string, version: number) {
    if (this.closing || !this.workspaces)
      throw new AppError(503, 'Reviewer runtime verification unavailable.');
    const workflow = new WorkflowStore(this.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    const source = reviewer?.sourceCandidate;
    const runtime = reviewer?.runtimeCandidate;
    if (
      !workflow ||
      workflow.version !== version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      reviewer?.state !== 'ready' ||
      !source ||
      !runtime ||
      !reviewer.bundle ||
      runtime.revision !== reviewer.approvedRevision ||
      runtime.sourceDigest !== source.digest
    )
      throw new AppError(409, 'Reviewer runtime checkpoint is missing or stale.');
    const task = coder.taskId ? this.store.task(coder.taskId) : undefined;
    const repository = this.store.repository(workflow.repositoryId);
    const workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    if (
      !repository ||
      !task ||
      task.state !== 'completed' ||
      !workspace ||
      workspace.id !== coder.evidence?.workspaceId ||
      task.repositoryId !== repository.id
    )
      throw new AppError(409, 'Coder workspace binding changed.');
    const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const paths = (await repositoryLeaseDirectories(repository, workspace.gitDir)).map(
      (directory) => join(lockRoot, createHash('sha256').update(directory).digest('hex')),
    );
    let release: () => Promise<void>;
    try {
      release = await acquireLocks(paths, repository.path);
    } catch {
      throw new AppError(409, 'Repository lease unavailable.');
    }
    try {
      await this.workspaces.validate(repository, workspace);
      const revision = await this.workspaces.revision(repository, workspace);
      const authorized = await this.workspaces.authorize(repository);
      const sourceId = basename(source.directory);
      const runtimeId = basename(runtime.directory);
      if (
        revision !== runtime.revision ||
        revision !== source.revision ||
        reviewer.bundle.revision !== revision ||
        source.directory !== join(authorized, 'workflow-reviewer-source', sourceId) ||
        runtime.directory !== join(authorized, 'workflow-reviewer-runtime', runtimeId) ||
        reviewer.bundle.directory !== join(authorized, 'workflow-evidence', reviewer.bundle.id)
      )
        throw new AppError(409, 'Reviewer runtime location or revision changed.');
      let valid = false;
      try {
        const manifest = JSON.parse(
          await readFile(join(source.directory, 'source-manifest.json'), 'utf8'),
        ) as ReviewerSourceManifest;
        const evidence = JSON.parse(
          await readFile(join(reviewer.bundle.directory, 'manifest.json'), 'utf8'),
        ) as SnapshotManifest;
        valid =
          manifest.revision === revision &&
          manifest.digest === source.digest &&
          Array.isArray(manifest.files) &&
          manifest.files.length === source.fileCount &&
          evidence.id === reviewer.bundle.id &&
          evidence.digest === reviewer.bundle.digest &&
          evidence.evidenceRevision === revision &&
          (await verifyEvidenceBundle(reviewer.bundle.directory, evidence)) &&
          (await verifyReviewerSourceCandidate(source.directory, manifest)) &&
          (await verifyReviewerGitContext({
            destinationRoot: join(authorized, 'workflow-reviewer-runtime'),
            directory: runtime.directory,
            commit: runtime.commit,
            manifest,
          }));
      } catch {
        // Fail closed when any durable source or Git metadata is corrupted.
      }
      if (!valid) throw new AppError(409, 'Reviewer runtime integrity validation failed.');
      if (new WorkflowStore(this.store.db).get(workflowId)?.version !== version)
        throw new AppError(409, 'Workflow changed during runtime verification.');
      return { workflowId, version, commit: runtime.commit, verified: true, runnable: false };
    } finally {
      await release();
    }
  }

  async prepareReviewerRuntime(workflowId: string, version: number) {
    if (this.closing || !this.workspaces) throw new AppError(503, 'Reviewer staging unavailable.');
    const workflow = new WorkflowStore(this.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    const source = reviewer?.sourceCandidate;
    if (
      !workflow ||
      workflow.version !== version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      reviewer?.state !== 'ready' ||
      !source ||
      !reviewer.bundle ||
      reviewer.runtimeCandidate ||
      reviewer.approvedRevision !== source.revision ||
      reviewer.bundle.revision !== source.revision
    )
      throw new AppError(409, 'Reviewer staging checkpoint is stale.');
    const task = coder.taskId ? this.store.task(coder.taskId) : undefined;
    const repo = this.store.repository(workflow.repositoryId);
    const workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    if (
      !task ||
      task.state !== 'completed' ||
      !repo ||
      !workspace ||
      workspace.id !== coder.evidence?.workspaceId ||
      task.repositoryId !== repo.id
    )
      throw new AppError(409, 'Coder source workspace changed.');
    const root = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const paths = (await repositoryLeaseDirectories(repo, workspace.gitDir)).map((directory) =>
      join(root, createHash('sha256').update(directory).digest('hex')),
    );
    let release: () => Promise<void>;
    try {
      release = await acquireLocks(paths, repo.path);
    } catch {
      throw new AppError(409, 'Repository is busy or has an unresolved lease.');
    }
    try {
      await this.workspaces.validate(repo, workspace);
      if ([...this.active.values()].some((run) => run.gitDir === repo.gitDir))
        throw new AppError(409, 'Agent is currently using the repository.');
      const revision = await this.workspaces.revision(repo, workspace);
      const authorized = await this.workspaces.authorize(repo);
      const sourceId = basename(source.directory);
      if (
        revision !== source.revision ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sourceId) ||
        source.directory !== join(authorized, 'workflow-reviewer-source', sourceId) ||
        reviewer.bundle.directory !== join(authorized, 'workflow-evidence', reviewer.bundle.id)
      )
        throw new AppError(409, 'Reviewer snapshot identity changed.');
      let manifest: ReviewerSourceManifest | undefined;
      let evidenceValid = false;
      try {
        manifest = JSON.parse(
          await readFile(join(source.directory, 'source-manifest.json'), 'utf8'),
        ) as ReviewerSourceManifest;
        const evidence = JSON.parse(
          await readFile(join(reviewer.bundle.directory, 'manifest.json'), 'utf8'),
        ) as SnapshotManifest;
        evidenceValid =
          evidence.id === reviewer.bundle.id &&
          evidence.digest === reviewer.bundle.digest &&
          evidence.evidenceRevision === revision &&
          (await verifyEvidenceBundle(reviewer.bundle.directory, evidence));
      } catch {
        // Malformed, missing and inaccessible evidence must fail closed.
      }
      if (
        !evidenceValid ||
        !manifest ||
        manifest.revision !== revision ||
        manifest.digest !== source.digest ||
        !Array.isArray(manifest.files) ||
        manifest.files.length !== source.fileCount ||
        !(await verifyReviewerSourceCandidate(source.directory, manifest))
      )
        throw new AppError(409, 'Reviewer source integrity check failed.');
      const destinationRoot = join(authorized, 'workflow-reviewer-runtime');
      await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
      const staged = await stageReviewerGitContext({
        sourceDirectory: source.directory,
        manifest,
        destinationRoot,
        verifyRevision: () => this.workspaces!.revision(repo, workspace),
      });
      try {
        const saved = new WorkflowStore(this.store.db).recordReviewerRuntime(
          workflowId,
          version,
          revision,
          {
            directory: staged.directory,
            commit: staged.commit,
            sourceDigest: staged.sourceDigest,
          },
        );
        return { workflow: saved, runtimeCommit: staged.commit, staged: true, runnable: false };
      } catch (error) {
        await removeReviewerGitContext(destinationRoot, staged.directory);
        throw error;
      }
    } finally {
      await release();
    }
  }

  async verifyPreparedReviewerSource(workflowId: string, version: number) {
    const workflow = new WorkflowStore(this.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    const source = reviewer?.sourceCandidate;
    if (
      !workflow ||
      workflow.version !== version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      reviewer?.state !== 'ready' ||
      !reviewer.bundle ||
      !source ||
      source.revision !== reviewer.approvedRevision ||
      source.revision !== coder.evidence?.revision ||
      source.revision !== reviewer.bundle.revision
    )
      throw new AppError(409, 'Reviewer source checkpoint is stale or missing.');
    const repository = this.store.repository(workflow.repositoryId);
    const task = coder.taskId ? this.store.task(coder.taskId) : undefined;
    const workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    if (
      !this.workspaces ||
      !repository ||
      !workspace ||
      !task ||
      task.state !== 'completed' ||
      workspace.id !== coder.evidence?.workspaceId ||
      task.repositoryId !== repository.id
    )
      throw new AppError(409, 'Source worktree binding is invalid.');
    const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockPaths = (await repositoryLeaseDirectories(repository, workspace.gitDir)).map(
      (directory) => join(lockRoot, createHash('sha256').update(directory).digest('hex')),
    );
    let release: () => Promise<void>;
    try {
      release = await acquireLocks(lockPaths, repository.path);
    } catch {
      throw new AppError(409, 'Repository is busy or has an unresolved lease.');
    }
    try {
      await this.workspaces.validate(repository, workspace);
      const revision = await this.workspaces.revision(repository, workspace);
      const authorizedRoot = await this.workspaces.authorize(repository);
      const sourceRoot = join(authorizedRoot, 'workflow-reviewer-source');
      const evidenceRoot = join(authorizedRoot, 'workflow-evidence');
      const sourceId = basename(source.directory);
      if (
        revision !== source.revision ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sourceId) ||
        source.directory !== join(sourceRoot, sourceId) ||
        reviewer.bundle.directory !== join(evidenceRoot, reviewer.bundle.id)
      )
        throw new AppError(409, 'Reviewer source location or revision changed.');
      let verified = false;
      try {
        const evidenceJson = await readFile(
          join(reviewer.bundle.directory, 'manifest.json'),
          'utf8',
        );
        const evidenceManifest = JSON.parse(evidenceJson) as SnapshotManifest;
        const sourceJson = await readFile(join(source.directory, 'source-manifest.json'), 'utf8');
        const sourceManifest = JSON.parse(sourceJson) as ReviewerSourceManifest;
        verified =
          evidenceManifest.id === reviewer.bundle.id &&
          evidenceManifest.digest === reviewer.bundle.digest &&
          evidenceManifest.evidenceRevision === source.revision &&
          Array.isArray(evidenceManifest.entries) &&
          evidenceManifest.entries.length === reviewer.bundle.fileCount &&
          (await verifyEvidenceBundle(reviewer.bundle.directory, evidenceManifest)) &&
          sourceManifest.revision === source.revision &&
          sourceManifest.digest === source.digest &&
          Array.isArray(sourceManifest.files) &&
          sourceManifest.files.length === source.fileCount &&
          (await verifyReviewerSourceCandidate(source.directory, sourceManifest));
      } catch {
        // Reject missing, malformed or inaccessible manifests without execution.
      }
      if (!verified) throw new AppError(409, 'Reviewer source verification failed.');
      if (new WorkflowStore(this.store.db).get(workflowId)?.version !== version)
        throw new AppError(409, 'Reviewer workflow changed during verification.');
      return {
        workflowId,
        version,
        sourceDigest: source.digest,
        evidenceDigest: reviewer.bundle.digest,
        verified: true,
        runnable: false,
      };
    } finally {
      await release();
    }
  }

  async inspectWorkflowBundle(workflowId: string, version: number) {
    const workflow = new WorkflowStore(this.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    const bundle = reviewer?.bundle;
    if (
      !workflow ||
      workflow.version !== version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      reviewer?.state !== 'ready' ||
      !bundle ||
      bundle.revision !== coder.evidence?.revision ||
      bundle.revision !== reviewer.approvedRevision
    )
      throw new AppError(409, 'Reviewer evidence checkpoint is stale or unavailable.');
    const repository = this.store.repository(workflow.repositoryId);
    if (!repository || !this.workspaces)
      throw new AppError(409, 'Repository verification is unavailable.');
    const task = coder.taskId ? this.store.task(coder.taskId) : undefined;
    const workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    if (!workspace || workspace.id !== coder.evidence?.workspaceId)
      throw new AppError(409, 'Coder worktree identity changed.');
    const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const locks = (await repositoryLeaseDirectories(repository, workspace.gitDir)).map(
      (directory) => join(lockRoot, createHash('sha256').update(directory).digest('hex')),
    );
    const release = await acquireLocks(locks, repository.path);
    try {
      await this.workspaces.validate(repository, workspace);
      const currentRevision = await this.workspaces.revision(repository, workspace);
      const destinationRoot = join(
        await this.workspaces.authorize(repository),
        'workflow-evidence',
      );
      if (
        currentRevision !== bundle.revision ||
        bundle.directory !== join(destinationRoot, bundle.id)
      )
        throw new AppError(409, 'Coder revision or evidence location changed.');
      let valid = false;
      try {
        const content = await readFile(join(bundle.directory, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(content) as SnapshotManifest;
        valid =
          manifest.id === bundle.id &&
          manifest.digest === bundle.digest &&
          manifest.evidenceRevision === bundle.revision &&
          Array.isArray(manifest.entries) &&
          manifest.entries.length === bundle.fileCount &&
          (await verifyEvidenceBundle(bundle.directory, manifest));
      } catch {
        // Missing, malformed and inaccessible bundle evidence must fail closed.
      }
      if (!valid) throw new AppError(409, 'Evidence bundle integrity verification failed.');
      if (new WorkflowStore(this.store.db).get(workflowId)?.version !== version)
        throw new AppError(409, 'Workflow changed during bundle verification.');
      return {
        workflowId,
        version,
        digest: bundle.digest,
        verified: true,
        runnable: false,
      };
    } finally {
      await release();
    }
  }

  /**
   * Read-only recovery inventory. Never deletes unknown bundles or replays work.
   * A per-workflow verification failure is recorded, not treated as approval.
   */
  async auditWorkflowBundles() {
    const workflows = new WorkflowStore(this.store.db).list();
    const results: {
      workflowId: string;
      version: number;
      bundleId: string;
      status: 'verified' | 'invalid';
    }[] = [];
    for (const workflow of workflows) {
      const bundle = workflow.stages[1]?.bundle;
      if (!bundle) continue;
      let status: 'verified' | 'invalid' = 'invalid';
      try {
        const result = await this.inspectWorkflowBundle(workflow.id, workflow.version);
        if (result.verified) status = 'verified';
      } catch {
        // Fail closed on unavailable workspace, stale revision or corrupt bytes.
      }
      results.push({
        workflowId: workflow.id,
        version: workflow.version,
        bundleId: bundle.id,
        status,
      });
    }
    return {
      scanned: results.length,
      valid: results.filter((item) => item.status === 'verified').length,
      invalid: results.filter((item) => item.status === 'invalid').length,
      results,
      executionAuthorized: false,
    };
  }

  reviewOperation(
    taskId: string,
    action: 'review' | 'keep' | 'reject' | 'verify' | 'feedback' | 'request-changes',
    command?: string,
    revision?: string,
    feedback?: FeedbackInput,
  ) {
    if (this.closing) throw new AppError(503, 'Server is shutting down.');
    const operation = this.performReview(taskId, action, command, revision, feedback);
    this.reviews.add(operation);
    void operation.finally(() => this.reviews.delete(operation)).catch(() => {});
    return operation;
  }
  private async performReview(
    taskId: string,
    action: 'review' | 'keep' | 'reject' | 'verify' | 'feedback' | 'request-changes',
    command?: string,
    revision?: string,
    feedback?: FeedbackInput,
  ) {
    const task = this.store.task(taskId);
    let workspace = task?.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
    const repository = task && this.store.repository(task.repositoryId);
    if (!task || !workspace || !repository || !this.workspaces)
      throw new AppError(404, 'Isolated workspace not found.');
    const workspaceId = workspace.id;
    if (action === 'request-changes') {
      const submitted = this.store.reviewRecord(workspaceId, revision ?? '');
      if (submitted?.continuationTaskId) return this.clean(submitted);
    }
    if (
      [...this.active.values()].some((run) => run.gitDir === repository.gitDir) ||
      this.store.queue().some((entry) => {
        const queued = this.store.task(entry.taskId);
        return (
          queued?.workspaceId === workspaceId ||
          (entry.resumeSessionId &&
            this.store.session(entry.resumeSessionId)?.workspaceId === workspaceId)
        );
      })
    )
      throw new AppError(409, 'Stop or cancel sessions using this workspace before review.');
    if (workspace.decision === 'rejected') {
      if (action === 'review') return { workspace, files: [], diff: '', commands: [] };
      throw new AppError(409, 'Workspace already rejected.');
    }
    const locks = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    await mkdir(locks, { recursive: true, mode: 0o700 });
    if (workspace.operation || workspace.recoveryError) {
      if (action === 'review')
        return this.clean({
          workspace: {
            ...workspace,
            recoveryError:
              workspace.recoveryError ??
              `Workspace ${workspace.operation} is incomplete or still running. Inspect processes and leases before manual recovery.`,
          },
          files: [],
          diff: '',
          commands: [],
        });
      throw new AppError(
        409,
        workspace.recoveryError ??
          'Workspace has an unresolved operation. Preserve files and inspect manually.',
      );
    }
    let release: () => Promise<void>;
    let cleanupConfirmed = true;
    try {
      const paths = (await repositoryLeaseDirectories(repository, workspace.gitDir)).map(
        (directory) => join(locks, createHash('sha256').update(directory).digest('hex')),
      );
      release = await acquireLocks(paths, repository.path);
    } catch {
      throw new AppError(409, 'Repository is busy or has an unresolved lease.');
    }
    try {
      // A prior operation may have completed between snapshot and lease acquisition.
      workspace = this.store.workspace(workspace.id)!;
      await this.workspaces.validate(repository, workspace);
      if (action === 'review') {
        const review = await this.workspaces.review(repository, workspace);
        return this.clean({
          ...review,
          record: this.store.captureReview(task, this.clean(review)),
        });
      }
      if (action === 'feedback') {
        if (!feedback || workspace.decision !== 'pending')
          throw new AppError(409, 'Only pending reviews accept draft feedback.');
        return this.clean(this.saveFeedback(taskId, feedback));
      }
      await this.workspaces.assertRevision(repository, workspace, revision);
      if (action === 'request-changes') {
        if (workspace.decision !== 'pending')
          throw new AppError(409, 'Only pending workspaces can continue.');
        const record = this.store.reviewRecord(workspace.id, revision!);
        if (!record?.comments.length) throw new AppError(409, 'Save actionable feedback first.');
        if (feedback?.version !== record.version)
          throw new AppError(409, 'Feedback changed. Reload and confirm again.');
        if (!record.sessionId || !record.threadId)
          throw new AppError(
            409,
            'This review has no resumable session. Inspect the saved task and native CLI transcript.',
          );
        const latest = this.store
          .tasks()
          .filter((item) => item.workspaceId === workspace!.id && item.sessionId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (latest?.sessionId !== record.sessionId)
          throw new AppError(409, 'Session changed. Refresh the latest task review.');
        const session = this.store.session(record.sessionId);
        if (session?.threadId !== record.threadId || session.workspaceId !== workspace.id)
          throw new AppError(409, 'Saved session identity changed. Manual recovery is required.');
        this.validateResume(task, session.id);
        if (!this.dashboard().ready || this.connectionBusy || this.store.queue().length >= 100)
          throw new AppError(409, 'Connection or queue unavailable. Refresh connection and retry.');
        await this.workspaces.validateExecution(repository, workspace);
        const prompt =
          'Apply the following developer review feedback in the current authorized worktree. References belong ONLY to the specified revision; never reinterpret outdated line anchors. Do not commit, push, merge or escalate permissions.\n' +
          JSON.stringify({
            revision: record.revision,
            workspace: workspace.path,
            branch: workspace.branch,
            feedback: record.comments,
            outdatedAnchorWarning:
              'All earlier-revision line anchors are outdated; inspect current code before applying feedback.',
          });
        if (
          this.store
            .queue()
            .some(
              (entry) =>
                this.store.task(entry.taskId)?.workspaceId === workspace!.id ||
                (entry.resumeSessionId &&
                  this.store.session(entry.resumeSessionId)?.workspaceId === workspace!.id),
            )
        )
          throw new AppError(
            409,
            'Another continuation was submitted. Cancel it before requesting changes.',
          );
        this.store.db.exec('BEGIN IMMEDIATE');
        let submitted: ReviewRecord;
        try {
          const next = this.store.createTask({
            repositoryId: task.repositoryId,
            agentId: task.agentId,
            executionMode: 'write',
            title: `Review corrections · ${task.title}`.slice(0, 160),
            prompt,
            reviewRequest: {
              revision: record.revision,
              sessionId: session.id,
              threadId: record.threadId,
            },
          });
          this.store.updateTask(next.id, { workspaceId: workspace.id });
          this.store.enqueue(next.id, this.auth.view().mode, session.id, false);
          submitted = this.store.saveReviewRecord({
            ...record,
            submittedAt: new Date().toISOString(),
            continuationTaskId: next.id,
          });
          this.store.db.exec('COMMIT');
        } catch (error) {
          this.store.db.exec('ROLLBACK');
          throw error;
        }
        this.emit(
          taskId,
          'review',
          'Changes requested; continuation submitted to the existing queue.',
        );
        this.wake();
        return this.clean(submitted);
      }
      const recordIntent = () =>
        this.store.saveWorkspace({
          ...workspace!,
          operation: action === 'reject' ? 'rejecting' : 'verifying',
        });
      const updated =
        action === 'reject'
          ? await this.workspaces.reject(repository, workspace, revision, recordIntent)
          : action === 'verify'
            ? await this.workspaces.verify(
                repository,
                workspace,
                command ?? '',
                recordIntent,
                this.shutdownController.signal,
              )
            : { ...workspace, decision: 'kept' as const };
      // Redact output, never rewrite filesystem identities through transcript redaction.
      this.store.saveWorkspace({
        ...updated,
        operation: undefined,
        verification: updated.verification
          ? {
              ...updated.verification,
              revision: action === 'verify' ? revision : workspace.verification?.revision,
              output: this.clean(updated.verification.output),
            }
          : undefined,
      });
      if (action === 'verify') {
        const record = this.store.reviewRecord(workspace.id, revision!);
        if (record)
          this.store.saveReviewRecord({
            ...record,
            verification: this.store.workspace(workspace.id)?.verification,
          });
      }
      this.emit(
        taskId,
        'review',
        action === 'verify' ? 'Verification finished.' : `Changes ${updated.decision}.`,
      );
      return this.clean(updated);
    } catch (error) {
      if (error instanceof UncertainCleanupError) cleanupConfirmed = false;
      const current = this.store.workspace(workspace.id)!;
      if (current.operation)
        this.store.saveWorkspace({
          ...current,
          recoveryError:
            'Workspace operation failed or was interrupted. Preserve remaining files and branches; inspect processes and Git worktrees before manual recovery.',
        });
      throw error;
    } finally {
      if (cleanupConfirmed) await release();
    }
  }
  async stop(taskId: string) {
    const active = [...this.active.values()].find((run) => run.taskId === taskId);
    if (!active) {
      if (!this.store.queue().some((entry) => entry.taskId === taskId))
        throw new AppError(409, 'This task is not active or submitted.');
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const task = this.store.task(taskId)!;
        this.store.removeQueued(taskId);
        this.store.updateTask(taskId, { state: 'stopped' });
        const workspace = task.workspaceId ? this.store.workspace(task.workspaceId) : undefined;
        if (workspace) this.store.saveWorkspace({ ...workspace, reviewEpoch: taskId });
        this.store.db.exec('COMMIT');
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        throw error;
      }
      this.waiting.delete(taskId);
      this.emit(taskId, 'state', 'Task stopped before execution.');
      this.wake();
      return;
    }
    if (active.quarantined) throw new UncertainCleanupError();
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
    this.shutdownController.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    const stopAgents = Promise.all(
      [...this.active.values()].map(async (active) => {
        if (active.quarantined) throw new UncertainCleanupError();
        if (this.store.task(active.taskId)?.state === 'queued') {
          active.preserveQueue = true;
          active.stopRequested = true;
          await active.done;
        } else await this.stop(active.taskId);
      }),
    );
    await Promise.all([stopAgents, Promise.allSettled([...this.reviews])]);
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
