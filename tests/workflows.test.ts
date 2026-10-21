import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { sandbox } from './helpers.js';
import { TaskManager } from '../src/server/manager.js';

it('pins stages, requires explicit approval and survives restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-workflow-'));
  const path = join(directory, 'metadata.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/workflow',
      gitDir: '/disposable/workflow/.git',
      name: 'workflow',
    });
    const coder = store.agent('codex-1')!;
    const writable = { ...coder, maximumMode: 'write' };
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify(writable), coder.id, coder.revision);
    const workflows = new WorkflowStore(store.db);
    const original = workflows.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: coder.id, agentRevision: 1, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
        { kind: 'qa', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    expect(original.stages.map((s) => s.state)).toEqual([
      'awaiting_approval',
      'pending',
      'pending',
    ]);
    expect(() =>
      workflows.transition(original.id, 0, {
        type: 'approve',
        revision: 'b'.repeat(40),
      }),
    ).toThrow();
    const approved = workflows.transition(original.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    expect(() =>
      workflows.transition(original.id, 0, {
        type: 'approve',
        revision: 'a'.repeat(40),
      }),
    ).toThrow();
    const running = workflows.transition(original.id, approved.version, {
      type: 'start',
      taskId: 'task-1',
      revision: 'a'.repeat(40),
    });
    expect(() =>
      workflows.transition(original.id, running.version, {
        type: 'cancel',
      }),
    ).toThrow();
    const finished = workflows.transition(original.id, running.version, {
      type: 'finish',
      taskId: 'task-1',
      revision: 'b'.repeat(40),
      succeeded: true,
    });
    store.close();
    store = new Store(path);
    const resumed = new WorkflowStore(store.db);
    expect(resumed.get(original.id)).toEqual(finished);
    expect(resumed.get(original.id)?.stages[1]?.state).toBe('awaiting_approval');
    expect(() =>
      resumed.transition(original.id, finished.version, {
        type: 'approve',
        revision: 'a'.repeat(40),
      }),
    ).toThrow();
    const reviewApproved = resumed.transition(original.id, finished.version, {
      type: 'approve',
      revision: 'b'.repeat(40),
    });
    const reviewStarted = resumed.transition(original.id, reviewApproved.version, {
      type: 'start',
      taskId: 'task-2',
      revision: 'b'.repeat(40),
    });
    const reviewDone = resumed.transition(original.id, reviewStarted.version, {
      type: 'finish',
      taskId: 'task-2',
      revision: 'b'.repeat(40),
      succeeded: true,
    });
    expect(reviewDone.stages[2]?.state).toBe('awaiting_approval');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects unauthorized profiles, invalid revisions and premature execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-workflow-invalid-'));
  const store = new Store(join(directory, 'metadata.sqlite'));
  try {
    const repo = store.register({
      path: '/disposable/workflow-invalid',
      gitDir: '/disposable/workflow-invalid/.git',
      name: 'workflow',
    });
    const service = new WorkflowStore(store.db);
    const input = {
      repositoryId: repo.id,
      baselineRevision: 'f'.repeat(40),
      stages: [
        { kind: 'coder' as const, agentId: 'codex-1', agentRevision: 1, mode: 'write' as const },
        {
          kind: 'reviewer' as const,
          agentId: 'codex-2',
          agentRevision: 1,
          mode: 'read-only' as const,
        },
      ],
    };
    expect(() => service.create(input)).toThrow();
    const coder = store.agent('codex-1')!;
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    expect(() => service.create({ ...input, baselineRevision: '../main' })).toThrow();
    const instance = service.create(input);
    expect(() =>
      service.transition(instance.id, 0, {
        type: 'start',
        taskId: 'unapproved',
        revision: 'f'.repeat(40),
      }),
    ).toThrow();
    const ready = service.transition(instance.id, 0, {
      type: 'approve',
      revision: 'f'.repeat(40),
    });
    const running = service.transition(instance.id, ready.version, {
      type: 'start',
      taskId: 'first',
      revision: 'f'.repeat(40),
    });
    const interrupted = service.transition(instance.id, running.version, {
      type: 'interrupt',
      taskId: 'first',
    });
    expect(interrupted.state).toBe('blocked');
    expect(() =>
      service.transition(instance.id, interrupted.version, {
        type: 'approve',
        revision: 'f'.repeat(40),
      }),
    ).toThrow();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('blocks a persisted running workflow after unexpected backend restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-workflow-recovery-'));
  const path = join(directory, 'metadata.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/recovery',
      gitDir: '/disposable/recovery/.git',
      name: 'fixture',
    });
    const coder = store.agent('codex-1')!;
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    const service = new WorkflowStore(store.db);
    const initial = service.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: 'codex-1', agentRevision: 1, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    const approved = service.transition(initial.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const task = store.createTask({
      repositoryId: repo.id,
      agentId: 'codex-1',
      title: 'Recovery fixture',
      prompt: 'No inference',
      executionMode: 'write',
    });
    store.updateTask(task.id, { state: 'running' });
    service.transition(initial.id, approved.version, {
      type: 'start',
      taskId: task.id,
      revision: 'a'.repeat(40),
    });
    store.close();
    store = new Store(path);
    const recovered = new WorkflowStore(store.db).get(initial.id)!;
    expect(store.task(task.id)?.state).toBe('interrupted');
    expect(recovered.state).toBe('blocked');
    expect(recovered.stages[0]?.state).toBe('interrupted');
    expect(recovered.stages[1]?.state).toBe('pending');
    expect(() =>
      new WorkflowStore(store.db).transition(initial.id, recovered.version, {
        type: 'approve',
        revision: 'a'.repeat(40),
      }),
    ).toThrow();
    store.close();
    store = new Store(path);
    expect(new WorkflowStore(store.db).get(initial.id)?.version).toBe(recovered.version);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('atomically binds only a matching unsubmitted task and rejects reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-workflow-bind-'));
  const store = new Store(join(directory, 'metadata.sqlite'));
  try {
    const repo = store.register({
      path: '/disposable/binding',
      gitDir: '/disposable/binding/.git',
      name: 'fixture',
    });
    const coder = store.agent('codex-1')!;
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    const service = new WorkflowStore(store.db);
    const create = () =>
      service.create({
        repositoryId: repo.id,
        baselineRevision: 'a'.repeat(40),
        stages: [
          { kind: 'coder', agentId: 'codex-1', agentRevision: 1, mode: 'write' },
          { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
        ],
      });
    const original = create();
    const approved = service.transition(original.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const mismatch = store.createTask({
      repositoryId: repo.id,
      agentId: 'codex-2',
      title: 'Wrong agent',
      prompt: 'review',
      executionMode: 'read-only',
    });
    expect(() => service.bindApprovedTask(original.id, approved.version, mismatch.id)).toThrow();
    const task = store.createTask({
      repositoryId: repo.id,
      agentId: 'codex-1',
      title: 'Coder',
      prompt: 'write',
      executionMode: 'write',
    });
    const bound = service.bindApprovedTask(original.id, approved.version, task.id);
    expect(bound.stages[0]?.taskId).toBe(task.id);
    expect(bound.stages[0]?.state).toBe('ready');
    expect(store.queue()).toEqual([]);
    expect(() => service.bindApprovedTask(original.id, approved.version, task.id)).toThrow();
    const other = create();
    const otherReady = service.transition(other.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    expect(() => service.bindApprovedTask(other.id, otherReady.version, task.id)).toThrow();
    const running = service.transition(original.id, bound.version, {
      type: 'start',
      taskId: task.id,
      revision: 'a'.repeat(40),
    });
    expect(running.stages[0]?.state).toBe('running');
    expect(store.queue()).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('submits a bound workflow stage atomically and refuses duplicate submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-workflow-queue-'));
  const store = new Store(join(directory, 'metadata.sqlite'));
  try {
    const repo = store.register({
      path: '/disposable/workflow-queue',
      gitDir: '/disposable/workflow-queue/.git',
      name: 'fixture',
    });
    const coder = store.agent('codex-1')!;
    // Update the current profile and its immutable version consistently.
    const write = store.editAgent(coder.id, coder.revision, {
      name: coder.name,
      role: coder.role,
      description: coder.description,
      instructions: coder.instructions,
      model: coder.model,
      maximumMode: 'write',
    });
    const workflows = new WorkflowStore(store.db);
    const workflow = workflows.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: write.id, agentRevision: write.revision, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    const approved = workflows.transition(workflow.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const task = store.createTask({
      repositoryId: repo.id,
      agentId: write.id,
      title: 'Implement',
      prompt: 'No execution',
      executionMode: 'write',
    });
    const bound = workflows.bindApprovedTask(workflow.id, approved.version, task.id);
    expect(() =>
      workflows.enqueueApprovedTask(
        store,
        workflow.id,
        bound.version,
        task.id,
        'local-cli-chatgpt',
        'b'.repeat(40),
      ),
    ).toThrow();
    expect(store.queue()).toEqual([]);
    expect(store.taskConfiguration(task.id)).toBeUndefined();
    const queued = workflows.enqueueApprovedTask(
      store,
      workflow.id,
      bound.version,
      task.id,
      'local-cli-chatgpt',
      'a'.repeat(40),
    );
    expect(queued.stages[0]?.state).toBe('running');
    expect(store.queue()).toHaveLength(1);
    expect(store.taskConfiguration(task.id)?.profileRevision).toBe(write.revision);
    expect(() =>
      workflows.enqueueApprovedTask(
        store,
        workflow.id,
        queued.version,
        task.id,
        'local-cli-chatgpt',
        'a'.repeat(40),
      ),
    ).toThrow();
    expect(store.queue()).toHaveLength(1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('never promotes a completed Coder task without verified output evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-terminal-'));
  const store = new Store(join(directory, 'metadata.sqlite'));
  try {
    const repo = store.register({
      path: '/disposable/terminal',
      gitDir: '/disposable/terminal/.git',
      name: 'fixture',
    });
    const coder = store.agent('codex-1')!;
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    const service = new WorkflowStore(store.db);
    const initial = service.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: 'codex-1', agentRevision: 1, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    const approved = service.transition(initial.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const task = store.createTask({
      repositoryId: repo.id,
      agentId: 'codex-1',
      executionMode: 'write',
      title: 'Coder',
      prompt: 'fixture',
    });
    const running = service.transition(initial.id, approved.version, {
      type: 'start',
      taskId: task.id,
      revision: 'a'.repeat(40),
    });
    store.updateTask(task.id, { state: 'completed' });
    expect(service.reconcileTerminals()).toBe(1);
    const blocked = service.get(initial.id)!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.stages[0]?.state).toBe('blocked');
    expect(blocked.stages[1]?.state).toBe('pending');
    expect(blocked.version).toBe(running.version + 1);
    expect(service.reconcileTerminals()).toBe(0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('removes persisted workflow queue entry on restart so it cannot execute without reapproval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-queue-restart-'));
  const path = join(directory, 'metadata.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/queue-restart',
      gitDir: '/disposable/queue-restart/.git',
      name: 'fixture',
    });
    const original = store.agent('codex-1')!;
    const profile = store.editAgent(original.id, original.revision, {
      name: original.name,
      role: original.role,
      description: original.description,
      instructions: original.instructions,
      model: original.model,
      maximumMode: 'write',
    });
    const workflows = new WorkflowStore(store.db);
    const created = workflows.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: profile.id, agentRevision: profile.revision, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    const approved = workflows.transition(created.id, created.version, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const task = store.createTask({
      repositoryId: repo.id,
      agentId: profile.id,
      title: 'Writing',
      prompt: 'Fixture',
      executionMode: 'write',
    });
    const bound = workflows.bindApprovedTask(created.id, approved.version, task.id);
    workflows.enqueueApprovedTask(
      store,
      created.id,
      bound.version,
      task.id,
      'local-cli-chatgpt',
      'a'.repeat(40),
    );
    expect(store.queue()).toHaveLength(1);
    store.close();
    store = new Store(path);
    expect(store.queue()).toEqual([]);
    expect(store.task(task.id)?.state).toBe('interrupted');
    expect(new WorkflowStore(store.db).get(created.id)?.state).toBe('blocked');
    store.close();
    store = new Store(path);
    expect(store.queue()).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('records verified review evidence once and rejects a mismatched workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-evidence-'));
  const store = new Store(join(directory, 'metadata.sqlite'));
  try {
    const repo = store.register({
      path: '/disposable/evidence',
      gitDir: '/disposable/evidence/.git',
      name: 'fixture',
    });
    const coder = store.agent('codex-1')!;
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    const workflows = new WorkflowStore(store.db);
    const created = workflows.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: 'codex-1', agentRevision: 1, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    const approved = workflows.transition(created.id, 0, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const task = store.createTask({
      repositoryId: repo.id,
      agentId: 'codex-1',
      executionMode: 'write',
      title: 'Coder',
      prompt: 'fixture',
    });
    const running = workflows.transition(created.id, approved.version, {
      type: 'start',
      taskId: task.id,
      revision: 'a'.repeat(40),
    });
    store.updateTask(task.id, { state: 'completed', workspaceId: 'worktree-1' });
    expect(workflows.reconcileTerminals()).toBe(1);
    const blocked = workflows.get(created.id)!;
    expect(blocked.version).toBe(running.version + 1);
    expect(() =>
      workflows.captureCoderEvidence(created.id, blocked.version, {
        taskId: task.id,
        workspaceId: 'different',
        revision: 'b'.repeat(64),
        fileCount: 1,
      }),
    ).toThrow();
    const captured = workflows.captureCoderEvidence(created.id, blocked.version, {
      taskId: task.id,
      workspaceId: 'worktree-1',
      revision: 'b'.repeat(64),
      fileCount: 1,
    });
    expect(captured.stages[0]?.evidence?.revision).toBe('b'.repeat(64));
    expect(captured.stages[1]?.state).toBe('pending');
    expect(captured.state).toBe('blocked');
    // The audit log must be bounded. Stale versions and unchanged snapshots
    // cannot turn a refresh into a second authorization.
    const refresh = (version: number, workspaceId: string, revision: string) =>
      workflows.captureCoderEvidence(
        created.id,
        version,
        { taskId: task.id, workspaceId, revision, fileCount: 1 },
        true,
      );
    expect(() => refresh(captured.version, 'worktree-1', 'b'.repeat(64))).toThrow();
    expect(() => refresh(blocked.version, 'worktree-1', 'c'.repeat(64))).toThrow();
    expect(() => refresh(captured.version, 'different', 'c'.repeat(64))).toThrow();
    expect(workflows.get(created.id)?.version).toBe(captured.version);
    expect(() =>
      workflows.approveCoderEvidence(created.id, captured.version, task.id, 'c'.repeat(64)),
    ).toThrow();
    const released = workflows.approveCoderEvidence(
      created.id,
      captured.version,
      task.id,
      'b'.repeat(64),
    );
    expect(released.stages[0]?.state).toBe('completed');
    expect(released.stages[1]?.state).toBe('awaiting_approval');
    expect(released.stages[1]?.approvedRevision).toBeNull();
    const reviewerApproved = workflows.transition(created.id, released.version, {
      type: 'approve',
      revision: 'b'.repeat(64),
    });
    expect(reviewerApproved.stages[1]?.state).toBe('ready');
    expect(reviewerApproved.stages[1]?.mode).toBe('read-only');
    expect(reviewerApproved.stages[1]?.taskId).toBeNull();
    const bundle = {
      id: '00000000-0000-4000-8000-000000000001',
      directory: '/disposable/bundles/00000000-0000-4000-8000-000000000001',
      digest: 'c'.repeat(64),
      fileCount: 1,
    };
    const recordBundle = (version: number, fileCount = 1) =>
      workflows.recordReviewerBundle(created.id, version, 'b'.repeat(64), {
        ...bundle,
        fileCount,
      });
    expect(() => recordBundle(reviewerApproved.version, 2)).toThrow();
    const saved = recordBundle(reviewerApproved.version);
    expect(saved.stages[1]?.bundle?.digest).toBe(bundle.digest);
    expect(saved.stages[1]?.bundle?.revision).toBe('b'.repeat(64));
    expect(saved.version).toBe(reviewerApproved.version + 1);
    expect(workflows.get(created.id)?.stages[1]?.bundle).toEqual(saved.stages[1]?.bundle);
    expect(() => recordBundle(reviewerApproved.version)).toThrow();
    expect(store.queue()).toEqual([]);
    expect(store.queue()).toEqual([]);
    expect(released.stages[1]?.taskId).toBeNull();
    expect(() =>
      workflows.approveCoderEvidence(created.id, released.version, task.id, 'b'.repeat(64)),
    ).toThrow();
    expect(() =>
      workflows.captureCoderEvidence(created.id, captured.version, {
        taskId: task.id,
        workspaceId: 'worktree-1',
        revision: 'b'.repeat(64),
        fileCount: 1,
      }),
    ).toThrow();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('a fresh TaskManager cannot dispatch a workflow queue left by a crashed process', async () => {
  const env = await sandbox();
  let restarted: Store | undefined;
  let manager: TaskManager | undefined;
  try {
    const repo = env.store.register({
      path: env.repository,
      gitDir: join(env.repository, '.git'),
      name: 'recovery fixture',
    });
    const coder = env.store.agent('codex-1')!;
    const workflows = new WorkflowStore(env.store.db);
    const created = workflows.create({
      repositoryId: repo.id,
      baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: coder.id, agentRevision: coder.revision, mode: 'write' },
        {
          kind: 'reviewer',
          agentId: 'codex-2',
          agentRevision: env.store.agent('codex-2')!.revision,
          mode: 'read-only',
        },
      ],
    });
    const approved = workflows.transition(created.id, created.version, {
      type: 'approve',
      revision: 'a'.repeat(40),
    });
    const task = env.store.createTask({
      repositoryId: repo.id,
      agentId: coder.id,
      title: 'Crash before worker claim',
      prompt: 'WRITE_FIXTURE',
      executionMode: 'write',
    });
    const bound = workflows.bindApprovedTask(created.id, approved.version, task.id);
    workflows.enqueueApprovedTask(
      env.store,
      created.id,
      bound.version,
      task.id,
      'local-cli-chatgpt',
      'a'.repeat(40),
    );
    expect(env.store.queue()).toHaveLength(1);
    // Simulate process restart without orderly shutdown: the original
    // connection is deliberately left open, with no worker ever dispatched.
    restarted = new Store(join(env.root, 'metadata.sqlite'));
    manager = new TaskManager(restarted, env.providers, env.auth);
    expect(restarted.queue()).toEqual([]);
    expect(restarted.task(task.id)?.state).toBe('interrupted');
    expect(new WorkflowStore(restarted.db).get(created.id)?.state).toBe('blocked');
    expect(manager.dashboard().agents.every((agent) => agent.state !== 'running')).toBe(true);
    expect(() => manager!.start(task.id, undefined, true)).toThrow();
    expect(restarted.queue()).toEqual([]);
  } finally {
    if (manager) await manager.shutdown();
    restarted?.close();
    await env.cleanup();
  }
});
