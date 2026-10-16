import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { sandbox, until } from './helpers.js';
import { validateRepository } from '../src/server/repositories.js';
import type { AgentId } from '../src/shared/types.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const a = await sandbox();
  const b = await sandbox();
  cleanups.push(a.cleanup, b.cleanup);
  const repoA = a.store.register(await validateRepository(a.repository));
  const repoB = a.store.register(await validateRepository(b.repository));
  const create = (agentId: AgentId, repo = repoA, prompt = 'WAIT_FIXTURE', title = 'Review') =>
    a.store.createTask({ repositoryId: repo.id, agentId, prompt, title });
  const live = (id: string) =>
    until(
      () => a.store.events(id),
      (events) => events.some((event) => event.kind === 'thread'),
    );
  const finish = (id: string) =>
    until(
      () => a.store.task(id)!,
      (task) => ['completed', 'stopped', 'failed'].includes(task.state),
    );
  return { a, b, repoA, repoB, create, live, finish };
}
it('runs two official-SDK fixture workers concurrently in different worktrees and isolates Stop', async () => {
  const { a, b, repoB, create, live, finish } = await setup();
  const first = create('codex-1');
  const second = create('codex-2', repoB);
  a.manager.start(first.id);
  a.manager.start(second.id);
  await Promise.all([live(first.id), live(second.id)]);
  expect(a.manager.dashboard().agents.map((agent) => agent.state)).toEqual(['running', 'running']);
  expect(
    a.store
      .sessions()
      .map((s) => s.agentId)
      .sort(),
  ).toEqual(['codex-1', 'codex-2']);
  expect(new Set(a.store.sessions().map((session) => session.threadId)).size).toBe(2);
  const bCursor = a.store.events(second.id).at(-1)!.id;
  await a.manager.stop(first.id);
  expect((await finish(first.id)).state).toBe('stopped');
  expect(a.store.task(second.id)?.state).toBe('running');
  await until(
    () => a.store.events(second.id, bCursor),
    (events) => events.some((event) => event.kind === 'progress'),
  );
  await a.manager.stop(second.id);
  expect(await readFile(join(a.repository, 'README.md'), 'utf8')).toBe('# Disposable example\n');
  expect(await readFile(join(b.repository, 'README.md'), 'utf8')).toBe('# Disposable example\n');
});
it('serializes the same canonical worktree and preserves its queued task until release', async () => {
  const { a, create, live, finish } = await setup();
  const first = create('codex-1');
  const second = create('codex-2', undefined, 'review');
  a.manager.start(first.id);
  await live(first.id);
  a.manager.start(second.id);
  expect(a.store.task(second.id)?.state).toBe('queued');
  expect(a.manager.dashboard().queue.find((q) => q.taskId === second.id)?.waitingReason).toContain(
    'Worktree busy',
  );
  expect(a.store.events(second.id).some((e) => e.kind === 'thread')).toBe(false);
  await a.manager.stop(first.id);
  expect((await finish(second.id)).state).toBe('completed');
});
it('orders FIFO within an assigned agent, cancels queued work without execution, and rejects duplicate submissions', async () => {
  const { a, create, live, finish } = await setup();
  const first = create('codex-1');
  const cancelled = create('codex-1', undefined, 'review');
  const next = create('codex-1', undefined, 'review');
  const last = create('codex-1', undefined, 'review');
  a.manager.start(first.id);
  await live(first.id);
  for (const task of [cancelled, next, last]) a.manager.start(task.id);
  expect(() => a.manager.start(next.id)).toThrow('already submitted');
  expect(a.store.queue().map((entry) => entry.taskId)).toEqual([cancelled.id, next.id, last.id]);
  await a.manager.stop(cancelled.id);
  expect(a.store.events(cancelled.id).some((event) => event.kind === 'thread')).toBe(false);
  await a.manager.stop(first.id);
  expect((await finish(last.id)).state).toBe('completed');
  expect((await finish(next.id)).state).toBe('completed');
  const nextThread = a.store.events(next.id).find((e) => e.kind === 'thread')!;
  const lastThread = a.store.events(last.id).find((e) => e.kind === 'thread')!;
  expect(nextThread.id).toBeLessThan(lastThread.id);
});
it('recovers submitted FIFO work and resumes the same agent-owned thread after a full runtime reopen', async () => {
  const { a, create, live } = await setup();
  const first = create('codex-2', undefined, 'review');
  a.manager.start(first.id);
  await until(
    () => a.store.task(first.id)!,
    (task) => task.state === 'completed',
  );
  const session = a.store.session(a.store.task(first.id)!.sessionId!)!;
  const held = create('codex-1');
  a.manager.start(held.id);
  await live(held.id);
  const resumed = create('codex-2', undefined, 'Continue');
  a.manager.start(resumed.id, session.id);
  const draft = create('codex-2', undefined, 'Do not start');
  await a.manager.shutdown();
  a.store.close();
  const store = new Store(join(a.root, 'metadata.sqlite'));
  const auth = new CodexAuth({ dataDir: a.root, inspectLocal: async () => a.inspection });
  await auth.refresh();
  const providers = ['1', '2'].map(
    (id) => new CodexProvider({ home: join(a.root, 'reopened', id), auth }),
  );
  const manager = new TaskManager(store, providers, auth);
  manager.startQueue();
  cleanups.push(async () => {
    await manager.shutdown();
    store.close();
  });
  const finished = await until(
    () => store.task(resumed.id)!,
    (task) => ['completed', 'failed'].includes(task.state),
  );
  expect(finished.state, finished.error ?? '').toBe('completed');
  expect(finished.sessionId).toBe(session.id);
  expect(finished.result).toContain('Resumed the saved review thread');
  expect(store.task(draft.id)?.state).toBe('queued');
  expect(store.events(draft.id)).toEqual([]);
  const wrong = store.createTask({
    repositoryId: first.repositoryId,
    agentId: 'codex-1',
    title: 'Wrong owner',
    prompt: 'review',
  });
  expect(() => manager.start(wrong.id, session.id)).toThrow('saved thread');
});
it('retains a submitted queue entry pinned to API mode rather than silently executing using local login', async () => {
  const { a, create, repoB, finish } = await setup();
  const task = create('codex-2', undefined, 'review');
  a.store.enqueue(task.id, 'api-key');
  // Complete actual local-mode work on A, proving a scheduler cycle ran while B stayed pinned.
  const local = create('codex-1', repoB, 'review');
  a.manager.start(local.id);
  expect((await finish(local.id)).state).toBe('completed');
  expect(a.store.task(task.id)?.state).toBe('queued');
  expect(a.store.queue()[0]?.mode).toBe('api-key');
  expect(a.store.events(task.id)).toEqual([]);
  expect(a.manager.dashboard().queue[0]?.waitingReason).toContain('submitted connection mode');
  await a.manager.stop(task.id);
});
it('respects a lease held by another actual application process without exposing its runtime metadata', async () => {
  const { a, create, finish } = await setup();
  const child = fork(new URL('./fixtures/runtime-child.ts', import.meta.url), [a.repository], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.connected) child.send('stop');
    await exited;
  });
  await once(child, 'message');
  const task = create('codex-2', undefined, 'review');
  a.manager.start(task.id);
  await until(
    () => a.manager.dashboard().queue.find((q) => q.taskId === task.id)?.waitingReason,
    (reason) => Boolean(reason?.includes('Worktree busy')),
  );
  expect(a.store.task(task.id)?.state).toBe('queued');
  expect(a.store.events(task.id).some((event) => event.kind === 'thread')).toBe(false);
  const metadata = JSON.stringify(a.manager.dashboard());
  expect(metadata).not.toContain('owner.json');
  expect(metadata).not.toContain('ai-office-worktrees-');
  child.send('stop');
  await exited;
  expect((await finish(task.id)).state).toBe('completed');
});

it('reaps its orphan worker group after abrupt backend death and keeps the worktree lease fail-closed', async () => {
  const { a, create } = await setup();
  const child = fork(new URL('./fixtures/runtime-child.ts', import.meta.url), [a.repository], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.connected) child.send('stop');
    await exited;
  });
  const [message] = (await once(child, 'message')) as [{ group: number; root: string }];
  expect(message.group).toBeGreaterThan(0);
  child.kill('SIGKILL');
  await exited;
  await until(
    () => {
      try {
        process.kill(-message.group, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    },
    (alive) => !alive,
  );
  const task = create('codex-2', undefined, 'review');
  a.manager.start(task.id);
  await until(
    () => a.manager.dashboard().queue[0]?.waitingReason,
    (reason) => Boolean(reason?.includes('Worktree busy')),
  );
  expect(a.store.task(task.id)?.state).toBe('queued');
  await a.manager.stop(task.id);
  // This test created the lease and confirmed both its owner and worker group are gone.
  // Production deliberately never performs this manual stale-lease cleanup.
  const repo = await validateRepository(a.repository);
  const hash = createHash('sha256').update(repo.gitDir).digest('hex');
  await rm(join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`, hash), {
    recursive: true,
    force: true,
  });
  await rm(message.root, { recursive: true, force: true });
});

it('bounds submissions and disallows sharing one provider instance between agent slots', async () => {
  const { a, create } = await setup();
  expect(() => new TaskManager(a.store, [a.provider, a.provider], a.auth)).toThrow('independent');
  for (let n = 0; n < 100; n++) {
    const task = create('codex-1', undefined, 'review');
    a.store.enqueue(task.id, 'api-key');
  }
  const overflow = create('codex-2', undefined, 'review');
  expect(() => a.manager.start(overflow.id)).toThrow('100');
  expect(a.store.sessions()).toEqual([]);
});

it('isolates a preparation failure and withholds private runtime diagnostics while the other slot continues', async () => {
  const { a, repoB, create, live, finish } = await setup();
  a.providers[0]!.startSession = async () => {
    throw new Error('SYNTHETIC_PRIVATE_RUNTIME_PATH');
  };
  const failed = create('codex-1');
  const running = create('codex-2', repoB);
  a.manager.start(failed.id);
  a.manager.start(running.id);
  await live(running.id);
  expect((await finish(failed.id)).state).toBe('failed');
  const persisted = JSON.stringify([a.store.task(failed.id), a.store.events(failed.id)]);
  expect(persisted).not.toContain('SYNTHETIC_PRIVATE_RUNTIME_PATH');
  expect(persisted).toContain('diagnostics were withheld');
  expect(a.store.task(running.id)?.state).toBe('running');
  await a.manager.stop(running.id);
});
