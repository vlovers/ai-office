import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
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
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
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

it('does not leave a resumable session without its binding when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-binding-'));
  const store = new Store(join(directory, 'metadata.sqlite'));
  try {
    const repository = store.register({
      path: '/disposable/atomic-binding',
      gitDir: '/disposable/atomic-binding/.git',
      name: 'fixture',
    });
    store.db.exec(
      `CREATE TRIGGER fail_binding BEFORE INSERT ON session_bindings BEGIN SELECT RAISE(ABORT,'synthetic binding failure'); END`,
    );
    expect(() =>
      store.createSession(repository.id, {
        mode: 'local-cli-chatgpt',
        contextId: 'synthetic',
        model: 'fixture',
        runtimeVersion: '0.162.1',
      }),
    ).toThrow('synthetic binding failure');
    expect(store.sessions()).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('migrates an actual schema-5 database without changing tasks and preserves schema-6 records on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-v5-'));
  const path = join(directory, 'metadata.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/v5',
      gitDir: '/disposable/v5/.git',
      name: 'v5',
    });
    const task = store.createTask({ repositoryId: repo.id, title: 'Preserve', prompt: 'Preserve' });
    const workspace = {
      id: 'fixture-workspace',
      repositoryId: repo.id,
      path: '/disposable/worktree',
      gitDir: '/disposable/git',
      branch: 'fixture',
      base: 'fixture',
      decision: 'rejected' as const,
    };
    store.attachWorkspace(task.id, workspace);
    const original = store.task(task.id);
    store.db.exec('DROP TABLE review_records; PRAGMA user_version=5;');
    store.close();
    store = new Store(path);
    expect(store.task(task.id)).toEqual(original);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(store.queue()).toEqual([]);
    const record = store.captureReview(store.task(task.id)!, {
      workspace,
      revision: 'a'.repeat(64),
      files: [],
      diff: '',
      commands: [],
    });
    store.saveComments(record, [
      { id: 'comment', body: 'Preserve rejected history', createdAt: 'now', updatedAt: 'now' },
    ]);
    store.close();
    store = new Store(path);
    expect(store.reviewRecords(workspace.id)[0]?.comments[0]?.body).toBe(
      'Preserve rejected history',
    );
    expect(store.workspace(workspace.id)?.decision).toBe('rejected');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('upgrades v8 metadata to v9 without losing existing work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-v8-v9-'));
  const path = join(directory, 'office.sqlite');
  let store = new Store(path);
  try {
    const repo = store.register({
      path: '/disposable/upgrade-v8',
      gitDir: '/disposable/upgrade-v8/.git',
      name: 'v8 fixture',
    });
    const task = store.createTask({
      repositoryId: repo.id,
      title: 'Preserve v8 task',
      prompt: 'no dispatch',
    });
    const session = store.createSession(repo.id);
    store.db.exec('DROP TABLE workflows; PRAGMA user_version=8;');
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(store.task(task.id)?.title).toBe('Preserve v8 task');
    expect(store.session(session.id)).toBeDefined();
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'")
        .get()?.name,
    ).toBe('workflows');
    expect(store.queue()).toEqual([]);
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(store.task(task.id)).toBeDefined();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('recovers running and stopping tasks exactly once across repeated SQLite restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-recovery-repeat-'));
  const path = join(directory, 'office.sqlite');
  let store = new Store(path);
  try {
    const repository = store.register({
      path: '/disposable/recovery-repeat',
      gitDir: '/disposable/recovery-repeat/.git',
      name: 'recovery-repeat',
    });
    const running = store.createTask({
      repositoryId: repository.id,
      title: 'Running at crash',
      prompt: 'do not replay',
    });
    const stopping = store.createTask({
      repositoryId: repository.id,
      title: 'Stopping at crash',
      prompt: 'do not replay',
    });
    store.updateTask(running.id, { state: 'running' });
    store.updateTask(stopping.id, { state: 'stopping' });
    store.close();
    store = new Store(path);
    for (const task of [running, stopping]) {
      expect(store.task(task.id)?.state).toBe('interrupted');
      expect(store.events(task.id).filter((event) => event.kind === 'interrupted')).toHaveLength(1);
    }
    expect(store.queue()).toEqual([]);
    store.close();
    store = new Store(path);
    for (const task of [running, stopping]) {
      expect(store.task(task.id)?.state).toBe('interrupted');
      expect(store.events(task.id).filter((event) => event.kind === 'interrupted')).toHaveLength(1);
    }
    expect(store.queue()).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('recovers an unfinished task after a real SIGKILL of its SQLite-owning process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-process-crash-'));
  const path = join(directory, 'office.sqlite');
  const store = new Store(path);
  const repository = store.register({
    path: '/disposable/process-crash',
    gitDir: '/disposable/process-crash/.git',
    name: 'process-crash',
  });
  const task = store.createTask({
    repositoryId: repository.id,
    title: 'Killed worker',
    prompt: 'must not replay',
  });
  store.close();

  // Use a separate OS process with a real SQLite connection, rather than
  // simulating a crash by calling Store.close() after a state update.
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL;');
    const row = db.prepare('SELECT json FROM tasks WHERE id=?').get(process.argv[2]);
    const task = { ...JSON.parse(row.json), state: 'running' };
    db.prepare('UPDATE tasks SET state=?, json=? WHERE id=?')
      .run('running', JSON.stringify(task), process.argv[2]);
    process.stdout.write('READY');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script, path, task.id], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let reopened: Store | undefined;
  try {
    let errorOutput = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('READY')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        reject(
          new Error(`SQLite worker exited before ready: ${code}/${signal}; stderr: ${errorOutput}`),
        ),
      );
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`SQLite worker readiness timed out; stderr: ${errorOutput}`)),
            10000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    reopened = new Store(path);
    expect(reopened.task(task.id)?.state).toBe('interrupted');
    expect(reopened.queue()).toEqual([]);
    expect(reopened.events(task.id).filter((event) => event.kind === 'interrupted')).toHaveLength(
      1,
    );
    reopened.close();
    reopened = new Store(path);
    expect(reopened.task(task.id)?.state).toBe('interrupted');
    expect(reopened.events(task.id).filter((event) => event.kind === 'interrupted')).toHaveLength(
      1,
    );
    expect(reopened.queue()).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    reopened?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
