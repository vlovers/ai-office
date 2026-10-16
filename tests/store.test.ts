import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';

it('persists thread IDs/events and recovers running tasks as interrupted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-store-'));
  const path = join(directory, 'office.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/example',
      gitDir: '/disposable/example/.git',
      name: 'example',
    });
    const session = store.createSession(repo.id, {
      mode: 'local-cli-chatgpt',
      contextId: 'private-context',
      model: 'fixture-model',
      runtimeVersion: '0.162.1',
    });
    store.setThread(session.id, 'thread-123');
    const task = store.createTask({ repositoryId: repo.id, title: 'Review', prompt: 'Review' });
    store.updateTask(task.id, { state: 'running', sessionId: session.id });
    const first = store.addEvent(task.id, 'progress', 'hello');
    store.close();
    store = new Store(path);
    expect(store.task(task.id)?.state).toBe('interrupted');
    expect(store.session(session.id)?.threadId).toBe('thread-123');
    expect(store.sessionBinding(session.id)?.contextId).toBe('private-context');
    expect(JSON.stringify(store.sessions())).not.toContain('private-context');
    expect(store.events(task.id, first.id).map((event) => event.kind)).toEqual(['interrupted']);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('upgrades version-1 metadata without guessing authentication for legacy sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-migration-'));
  const path = join(directory, 'office.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/legacy',
      gitDir: '/disposable/legacy/.git',
      name: 'legacy',
    });
    const session = store.createSession(repo.id);
    store.setThread(session.id, 'legacy-thread');
    store.db.exec('DROP TABLE session_bindings; DROP TABLE task_queue; PRAGMA user_version=1;');
    store.close();
    store = new Store(path);
    expect(store.session(session.id)?.threadId).toBe('legacy-thread');
    expect(store.session(session.id)?.authMode).toBeUndefined();
    expect(store.sessionBinding(session.id)).toBeUndefined();
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('transactionally migrates v2 tasks and sessions without auto-submitting legacy queued tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-v2-'));
  const path = join(directory, 'office.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/v2',
      gitDir: '/disposable/v2/.git',
      name: 'v2',
    });
    const binding = {
      mode: 'local-cli-chatgpt' as const,
      contextId: 'synthetic-context',
      model: 'fixture-model',
      runtimeVersion: '0.162.1',
    };
    const session = store.createSession(repo.id, binding);
    store.setThread(session.id, 'synthetic-v2-thread');
    const queued = store.createTask({
      repositoryId: repo.id,
      title: 'Legacy queue',
      prompt: 'keep',
    });
    const interrupted = store.createTask({
      repositoryId: repo.id,
      title: 'Legacy run',
      prompt: 'keep',
    });
    store.updateTask(interrupted.id, { state: 'running', sessionId: session.id });
    const original = { ...store.session(session.id)! };
    delete original.agentId;
    store.db
      .prepare('UPDATE sessions SET json=? WHERE id=?')
      .run(JSON.stringify(original), session.id);
    store.db.exec('DROP TABLE task_queue; PRAGMA user_version=2;');
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    expect(store.session(session.id)?.agentId).toBe('codex-1');
    expect(store.session(session.id)?.threadId).toBe('synthetic-v2-thread');
    expect(store.sessionBinding(session.id)).toEqual(binding);
    expect(store.task(queued.id)?.state).toBe('queued');
    expect(store.queue()).toEqual([]);
    expect(store.task(interrupted.id)?.state).toBe('interrupted');
    expect(store.events(interrupted.id).at(-1)?.kind).toBe('interrupted');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rolls back schema and ownership changes if migration encounters malformed legacy metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-rollback-'));
  const path = join(directory, 'office.sqlite');
  const store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/rollback',
      gitDir: '/disposable/rollback/.git',
      name: 'rollback',
    });
    const task = store.createTask({ repositoryId: repo.id, title: 'Preserve', prompt: 'keep' });
    const legacy = { ...task } as Partial<typeof task>;
    delete legacy.agentId;
    const original = JSON.stringify(legacy);
    store.db.prepare('UPDATE tasks SET json=? WHERE id=?').run(original, task.id);
    store.db
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run('malformed-session', repo.id, 'not-json');
    store.db.exec('DROP TABLE task_queue; PRAGMA user_version=2;');
    store.close();
    expect(() => new Store(path)).toThrow();
    const inspection = new DatabaseSync(path);
    try {
      expect(inspection.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(
        inspection.prepare("SELECT name FROM sqlite_master WHERE name='task_queue'").get(),
      ).toBeUndefined();
      expect(inspection.prepare('SELECT json FROM tasks WHERE id=?').get(task.id)?.json).toBe(
        original,
      );
    } finally {
      inspection.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
