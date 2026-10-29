import { expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { sandbox } from './helpers.js';

it('exposes interrupted tasks after an HTTP backend restart without replaying them', async () => {
  const env = await sandbox();
  const repository = env.store.register({
    path: env.repository,
    gitDir: join(env.repository, '.git'),
    name: 'recovery-fixture',
  });
  const running = env.store.createTask({
    repositoryId: repository.id,
    title: 'Interrupted by backend exit',
    prompt: 'must not be replayed',
  });
  env.store.updateTask(running.id, { state: 'running' });
  // Simulate persisted state left by an abruptly terminated backend. The real
  // process-kill path is covered separately by the SQLite SIGKILL regression.
  env.store.close();
  let recovered: Store | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    recovered = new Store(join(env.root, 'metadata.sqlite'));
    const auth = new CodexAuth({ dataDir: env.root, inspectLocal: async () => env.inspection });
    await auth.refresh();
    const provider = new CodexProvider({ home: join(env.root, 'restart-worker'), auth });
    const manager = new TaskManager(recovered, provider, auth);
    app = await createApp(manager);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/dashboard`);
    expect(response.status).toBe(200);
    const dashboard = (await response.json()) as {
      tasks: Array<{ id: string; state: string }>;
      queue: Array<{ taskId: string }>;
    };
    expect(dashboard.tasks.find((task) => task.id === running.id)?.state).toBe('interrupted');
    expect(dashboard.queue.some((item) => item.taskId === running.id)).toBe(false);
    expect(
      recovered.events(running.id).filter((event) => event.kind === 'interrupted'),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recovered.task(running.id)?.state).toBe('interrupted');
    expect(recovered.queue()).toEqual([]);
    const start = await fetch(address + '/api/tasks/' + running.id + '/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(start.status).toBe(409);
    expect(recovered.task(running.id)?.state).toBe('interrupted');
    expect(
      recovered.events(running.id).filter((event) => event.kind === 'interrupted'),
    ).toHaveLength(1);
  } finally {
    await app?.close();
    recovered?.close();
    await env.cleanup();
  }
});
