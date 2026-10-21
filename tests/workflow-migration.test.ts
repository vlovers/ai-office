import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';

it('migrates v0.6 schema 8 without changing tasks, pinned profiles, queue intent or a closed-file backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-v08-migration-'));
  const file = join(root, 'metadata.sqlite');
  const backup = join(root, 'before-upgrade.sqlite');
  let store = new Store(file);
  try {
    const repository = store.register({
      path: '/disposable/migration',
      gitDir: '/disposable/migration/.git',
      name: 'migration',
    });
    const task = store.createTask({
      repositoryId: repository.id,
      title: 'Existing v0.6 task',
      prompt: 'Preserve this task',
    });
    store.enqueue(task.id, 'local-cli-chatgpt');
    const pinned = store.taskConfiguration(task.id);
    const profiles = store.agents();
    const queue = store.queue();
    store.db.exec('DROP TABLE workflows; PRAGMA user_version=8;');
    store.close();
    await copyFile(file, backup);
    const bytes = await readFile(backup);
    store = new Store(file);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(store.task(task.id)).toEqual(task);
    expect(store.taskConfiguration(task.id)).toEqual(pinned);
    expect(store.agents()).toEqual(profiles);
    expect(store.queue()).toEqual(queue);
    expect(new WorkflowStore(store.db).list()).toEqual([]);
    expect(await readFile(backup)).toEqual(bytes);
    const saved = new DatabaseSync(backup, { readOnly: true });
    try {
      expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(8);
    } finally {
      saved.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('recovers queued and running QA stages fail-closed and is idempotent across repeated restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-qa-recovery-'));
  const file = join(root, 'metadata.sqlite');
  let store = new Store(file);
  try {
    const repository = store.register({
      path: '/disposable/qa-recovery',
      gitDir: '/disposable/qa-recovery/.git',
      name: 'recovery',
    });
    const coder = store.agent('codex-1')!;
    store.editAgent(coder.id, coder.revision, { ...coder, maximumMode: 'write' });
    const workflows = new WorkflowStore(store.db);
    const ids: string[] = [];
    const taskIds: string[] = [];
    for (const state of ['queued', 'running'] as const) {
      const workflow = workflows.create({
        repositoryId: repository.id,
        baselineRevision: 'a'.repeat(40),
        stages: [
          { kind: 'coder', agentId: 'codex-1', agentRevision: 2, mode: 'write' },
          { kind: 'reviewer', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
          { kind: 'qa', agentId: 'codex-2', agentRevision: 1, mode: 'read-only' },
        ],
      });
      const task = store.createTask({
        repositoryId: repository.id,
        agentId: 'codex-2',
        title: 'QA interrupted',
        prompt: 'No process should run',
      });
      store.enqueue(task.id, 'local-cli-chatgpt');
      if (state === 'running') store.claimQueued(task.id);
      workflow.stages[0]!.state = 'completed';
      workflow.stages[1]!.state = 'completed';
      workflow.stages[2]!.state = 'running';
      workflow.stages[2]!.taskId = task.id;
      store.db
        .prepare('UPDATE workflows SET json=? WHERE id=?')
        .run(JSON.stringify(workflow), workflow.id);
      ids.push(workflow.id);
      taskIds.push(task.id);
    }
    store.close();
    store = new Store(file);
    expect(store.queue()).toEqual([]);
    for (const taskId of taskIds) expect(store.task(taskId)?.state).toBe('interrupted');
    const recovered = new WorkflowStore(store.db).list();
    for (const workflow of recovered) {
      expect(workflow.state).toBe('blocked');
      expect(workflow.stages[2]!.state).toBe('interrupted');
    }
    store.close();
    store = new Store(file);
    expect(new WorkflowStore(store.db).list()).toEqual(recovered);
    expect(new Set(recovered.map((workflow) => workflow.id))).toEqual(new Set(ids));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
