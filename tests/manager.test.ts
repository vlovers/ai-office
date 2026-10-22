import { afterEach, expect, it, vi } from 'vitest';
import * as locks from '../src/server/lock.js';
import { sandbox, until } from './helpers.js';
import { validateRepository } from '../src/server/repositories.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it('publishes ordinary terminal state only after asynchronous lease release', async () => {
  const env = await setup('FAIL_FIXTURE');
  const acquire = locks.acquireLocks;
  let releaseStarted = false;
  let allowRelease!: () => void;
  const barrier = new Promise<void>((resolve) => {
    allowRelease = resolve;
  });
  const delayed = vi.spyOn(locks, 'acquireLocks').mockImplementation(async (...args) => {
    const release = await acquire(...args);
    return async () => {
      releaseStarted = true;
      await barrier;
      await release();
    };
  });
  try {
    env.manager.start(env.task.id);
    await until(() => releaseStarted, Boolean);
    expect(env.store.task(env.task.id)?.state).toBe('running');
    expect(env.manager.dashboard().agent.state).toBe('running');
    allowRelease();
    await until(
      () => env.store.task(env.task.id)!,
      (task) => task.state === 'failed',
    );
    expect(env.manager.dashboard().agent.state).toBe('idle');
  } finally {
    allowRelease();
    delayed.mockRestore();
  }
});
async function setup(prompt: string) {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const repo = env.store.register(await validateRepository(env.repository));
  const task = env.store.createTask({ repositoryId: repo.id, title: 'Test review', prompt });
  return { ...env, repo, task };
}
it('records provider failure and releases the agent for a subsequent task', async () => {
  const env = await setup('FAIL_FIXTURE');
  env.manager.start(env.task.id);
  const finished = await until(
    () => env.store.task(env.task.id)!,
    (task) => task.state === 'failed',
  );
  expect(finished.error).toContain('Codex task failed');
  expect(env.manager.dashboard().agent.state).toBe('idle');
  const next = env.store.createTask({
    repositoryId: env.repo.id,
    title: 'Try again',
    prompt: 'review',
  });
  env.manager.start(next.id);
  await until(
    () => env.store.task(next.id)!,
    (task) => task.state === 'completed',
  );
  const events = env.store.events(next.id);
  expect(events.filter((event) => event.kind === 'result')).toHaveLength(1);
  expect(events.find((event) => event.kind === 'result')?.message).not.toContain(
    'Interim commentary',
  );
  expect(
    events.some(
      (event) => event.kind === 'progress' && event.message.includes('Interim commentary'),
    ),
  ).toBe(true);
});
it('queues an assigned agent’s next task and stops a process that ignores SIGTERM', async () => {
  const env = await setup('WAIT_FIXTURE');
  env.manager.start(env.task.id);
  const another = env.store.createTask({
    repositoryId: env.repo.id,
    title: 'Other',
    prompt: 'review',
  });
  env.manager.start(another.id);
  expect(env.store.queue().some((entry) => entry.taskId === another.id)).toBe(true);
  await until(
    () => env.store.events(env.task.id),
    (events) => events.some((event) => event.kind === 'thread'),
  );
  await env.manager.stop(env.task.id);
  expect(env.store.task(env.task.id)?.state).toBe('stopped');
  expect(env.manager.dashboard().agent.taskId).not.toBe(env.task.id);
  await until(
    () => env.store.task(another.id)!,
    (task) => task.state === 'completed',
  );
});
it('treats unexpected CLI termination as failure, and validates session ownership', async () => {
  const env = await setup('EXIT_FIXTURE');
  expect(() => env.manager.start(env.task.id, 'missing-session')).toThrow('saved thread');
  env.manager.start(env.task.id);
  const task = await until(
    () => env.store.task(env.task.id)!,
    (task) => task.state === 'failed',
  );
  expect(task.error).toContain('code 7');
  expect(() => env.manager.start(env.task.id)).toThrow('new task');
});
it('stops safely if shutdown arrives while a task is preparing', async () => {
  const env = await setup('WAIT_FIXTURE');
  env.manager.start(env.task.id);
  await until(
    () => env.store.task(env.task.id)!.state,
    (state) => state === 'running',
  );
  await env.manager.shutdown();
  expect(env.store.task(env.task.id)?.state).toBe('stopped');
  const next = env.store.createTask({ repositoryId: env.repo.id, title: 'Late', prompt: 'review' });
  expect(() => env.manager.start(next.id)).toThrow('shutting down');
});
