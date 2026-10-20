import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';

it('pins stages, requires explicit approval and survives restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-workflow-'));
  const path = join(directory, 'metadata.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/workflow', gitDir: '/disposable/workflow/.git', name: 'workflow'
    });
    const coder = store.agent('codex-1')!;
    const writable = { ...coder, maximumMode: 'write' };
    store.db.prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify(writable), coder.id, coder.revision);
    const workflows = new WorkflowStore(store.db);
    const original = workflows.create({
      repositoryId: repo.id, baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: coder.id, agentRevision: 1, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
        { kind: 'qa', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    expect(original.stages.map(s => s.state)).toEqual([
      'awaiting_approval', 'pending', 'pending'
    ]);
    expect(() => workflows.transition(original.id, 0, {
      type: 'approve', revision: 'b'.repeat(40)
    })).toThrow();
    const approved = workflows.transition(original.id, 0, {
      type: 'approve', revision: 'a'.repeat(40)
    });
    expect(() => workflows.transition(original.id, 0, {
      type: 'approve', revision: 'a'.repeat(40)
    })).toThrow();
    const running = workflows.transition(original.id, approved.version, {
      type: 'start', taskId: 'task-1', revision: 'a'.repeat(40)
    });
    expect(() => workflows.transition(original.id, running.version, {
      type: 'cancel'
    })).toThrow();
    const finished = workflows.transition(original.id, running.version, {
      type: 'finish', taskId: 'task-1', revision: 'b'.repeat(40), succeeded: true
    });
    store.close();
    store = new Store(path);
    const resumed = new WorkflowStore(store.db);
    expect(resumed.get(original.id)).toEqual(finished);
    expect(resumed.get(original.id)?.stages[1]?.state).toBe('awaiting_approval');
    expect(() => resumed.transition(original.id, finished.version, {
      type: 'approve', revision: 'a'.repeat(40)
    })).toThrow();
    const reviewApproved = resumed.transition(original.id, finished.version, {
      type: 'approve', revision: 'b'.repeat(40)
    });
    const reviewStarted = resumed.transition(original.id, reviewApproved.version, {
      type: 'start', taskId: 'task-2', revision: 'b'.repeat(40)
    });
    const reviewDone = resumed.transition(original.id, reviewStarted.version, {
      type: 'finish', taskId: 'task-2', revision: 'b'.repeat(40), succeeded: true
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
      path: '/disposable/workflow-invalid', gitDir: '/disposable/workflow-invalid/.git',
      name: 'workflow'
    });
    const service = new WorkflowStore(store.db);
    const input = {
      repositoryId: repo.id, baselineRevision: 'f'.repeat(40),
      stages: [
        { kind: 'coder' as const, agentId: 'codex-1', agentRevision: 1, mode: 'write' as const },
        { kind: 'reviewer' as const, agentId: 'codex-2', agentRevision: 1, mode: 'read-only' as const },
      ],
    };
    expect(() => service.create(input)).toThrow();
    const coder = store.agent('codex-1')!;
    store.db.prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    expect(() => service.create({ ...input, baselineRevision: '../main' })).toThrow();
    const instance = service.create(input);
    expect(() => service.transition(instance.id, 0, {
      type: 'start', taskId: 'unapproved', revision: 'f'.repeat(40)
    })).toThrow();
    const ready = service.transition(instance.id, 0, {
      type: 'approve', revision: 'f'.repeat(40)
    });
    const running = service.transition(instance.id, ready.version, {
      type: 'start', taskId: 'first', revision: 'f'.repeat(40)
    });
    const interrupted = service.transition(instance.id, running.version, {
      type: 'interrupt', taskId: 'first'
    });
    expect(interrupted.state).toBe('blocked');
    expect(() => service.transition(instance.id, interrupted.version, {
      type: 'approve', revision: 'f'.repeat(40)
    })).toThrow();
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
      path: '/disposable/recovery', gitDir: '/disposable/recovery/.git', name: 'fixture'
    });
    const coder = store.agent('codex-1')!;
    store.db.prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, 1);
    const service = new WorkflowStore(store.db);
    const initial = service.create({
      repositoryId: repo.id, baselineRevision: 'a'.repeat(40),
      stages: [
        { kind: 'coder', agentId: 'codex-1', agentRevision: 1, mode: 'write' },
        { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
      ],
    });
    const approved = service.transition(initial.id, 0, { type: 'approve', revision: 'a'.repeat(40) });
    const task = store.createTask({ repositoryId: repo.id, agentId: 'codex-1',
      title: 'Recovery fixture', prompt: 'No inference', executionMode: 'write' });
    store.updateTask(task.id, { state: 'running' });
    service.transition(initial.id, approved.version, {
      type: 'start', taskId: task.id, revision: 'a'.repeat(40)
    });
    store.close();
    store = new Store(path);
    const recovered = new WorkflowStore(store.db).get(initial.id)!;
    expect(store.task(task.id)?.state).toBe('interrupted');
    expect(recovered.state).toBe('blocked');
    expect(recovered.stages[0]?.state).toBe('interrupted');
    expect(recovered.stages[1]?.state).toBe('pending');
    expect(() => new WorkflowStore(store.db).transition(initial.id, recovered.version, {
      type: 'approve', revision: 'a'.repeat(40)
    })).toThrow();
    store.close();
    store = new Store(path);
    expect(new WorkflowStore(store.db).get(initial.id)?.version).toBe(recovered.version);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
