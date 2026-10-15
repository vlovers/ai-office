import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    store.db.exec('DROP TABLE session_bindings; PRAGMA user_version=1;');
    store.close();
    store = new Store(path);
    expect(store.session(session.id)?.threadId).toBe('legacy-thread');
    expect(store.session(session.id)?.authMode).toBeUndefined();
    expect(store.sessionBinding(session.id)).toBeUndefined();
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
