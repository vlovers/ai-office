// Private fixture backend used to verify leases across actual OS processes; never reads auth.
import { sandbox } from '../helpers.js';
import { validateRepository } from '../../src/server/repositories.js';
const env = await sandbox(process.argv[2]!);
const repo = env.store.register(await validateRepository(env.repository));
const task = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-1',
  title: 'Child fixture',
  prompt: 'WAIT_FIXTURE',
});
let stopping = false;
const close = async () => {
  if (stopping) return;
  stopping = true;
  await env.cleanup();
  if (process.connected) process.disconnect?.();
};
process.on('message', () => void close());
process.on('disconnect', () => void close());
env.manager.events.on('event', (event) => {
  if (event.kind === 'thread') {
    // Test-driver IPC only; these values are never sent through the application API.
    const runs = (env.provider as unknown as { runs: Map<string, { child: { pid?: number } }> })
      .runs;
    process.send?.({ type: 'started', group: [...runs.values()][0]?.child.pid, root: env.root });
  }
});
env.manager.start(task.id);
