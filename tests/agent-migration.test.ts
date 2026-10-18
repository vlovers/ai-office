import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { createV05Fixture } from './fixtures/v05.js';

it('opens independently constructed schema-6 state without losing ownership, queued resumes or review history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-v05-migration-'));
  const path = join(root, 'fixture.sqlite');
  const fixture = createV05Fixture(path);
  let store: Store | undefined;
  try {
    store = new Store(path);
    expect(store.repository(fixture.repository.id)).toEqual(fixture.repository);
    expect(store.sessions()).toEqual(fixture.sessions);
    expect(store.task(fixture.tasks[0]!.id)?.state).toBe('interrupted');
    expect(store.workspace(fixture.workspace.id)).toEqual({
      ...fixture.workspace,
      reviewEpoch: fixture.tasks[0]!.id,
    });
    for (const task of fixture.tasks.slice(1)) expect(store.task(task.id)).toEqual(task);
    expect(store.queue()).toEqual([
      {
        taskId: fixture.tasks[1]!.id,
        agentId: 'codex-2',
        order: 42,
        enqueuedAt: fixture.tasks[1]!.createdAt,
        mode: 'local-cli-chatgpt',
        resumeSessionId: fixture.sessions[1]!.id,
      },
    ]);
    expect(store.reviewRecords(fixture.workspace.id)).toEqual([fixture.review]);
    expect(store.events(fixture.tasks[2]!.id)[0]?.message).toBe('Retain this event');
    expect(store.sessionBinding(fixture.sessions[0]!.id)?.contextId).toBe(
      'synthetic-private-binding',
    );
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const recovered = store.tasks();
    store.close();
    store = new Store(path);
    expect(store.tasks()).toEqual(recovered);
    expect(
      store.events(fixture.tasks[0]!.id).filter((event) => event.kind === 'interrupted'),
    ).toHaveLength(1);
    expect(store.reviewRecords(fixture.workspace.id)).toEqual([fixture.review]);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rolls back recovery when legacy metadata is malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-v05-rollback-'));
  const path = join(root, 'fixture.sqlite');
  const fixture = createV05Fixture(path);
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE workspaces SET json=? WHERE id=?').run('invalid-json', fixture.workspace.id);
    expect(() => new Store(path)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
    expect(
      JSON.parse(
        String(db.prepare('SELECT json FROM tasks WHERE id=?').get(fixture.tasks[0]!.id)?.json),
      ),
    ).toEqual(fixture.tasks[0]);
    expect(db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(1);
    expect(db.prepare('SELECT sequence FROM task_queue').get()?.sequence).toBe(42);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
