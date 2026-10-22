import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Workspaces } from './workspaces.js';
import { z } from 'zod';
import { Store } from './store.js';
import { TaskManager } from './manager.js';
import { CodexProvider } from './providers/codex.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';
import { AGENT_IDS } from '../shared/types.js';
import { CodexAuth } from './providers/codex-auth.js';

process.umask(0o077);
const data = resolve(process.env.AI_OFFICE_DATA_DIR ?? '.ai-office');
await mkdir(data, { recursive: true, mode: 0o700 });
await chmod(data, 0o700);
const release = await acquireLock(join(data, 'server.lock'), 'AI Office metadata');
let store: Store | undefined;
try {
  store = new Store(join(data, 'office.sqlite'));
  const auth = new CodexAuth({
    dataDir: data,
    apiKey: process.env.CODEX_API_KEY,
    localExecutable: process.env.AI_OFFICE_CODEX_EXECUTABLE,
  });
  await auth.refresh();
  const providers = AGENT_IDS.map(
    (id) => new CodexProvider({ home: join(data, 'workers', id), auth }),
  );
  const commands = z
    .record(z.string(), z.array(z.string().min(1)).min(1))
    .parse(JSON.parse(process.env.AI_OFFICE_VERIFICATION_COMMANDS ?? '{}'));
  const workspaces =
    process.env.AI_OFFICE_AUTHORIZED_ROOT && process.env.AI_OFFICE_WORKSPACE_ROOT
      ? new Workspaces({
          authorizedRoot: process.env.AI_OFFICE_AUTHORIZED_ROOT,
          workspaceRoot: process.env.AI_OFFICE_WORKSPACE_ROOT,
          commands,
          allowHostVerification: process.env.AI_OFFICE_ALLOW_HOST_VERIFICATION === '1',
        })
      : undefined;
  const manager = new TaskManager(
    store,
    providers,
    auth,
    process.env.CODEX_API_KEY,
    undefined,
    workspaces,
    {
      createProvider: (id) => new CodexProvider({ home: join(data, 'workers', id), auth }),
      concurrency: 2,
    },
  );
  const app = await createApp(manager);
  let stopping = false;
  const shutdown = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
      store?.close();
      await release();
      process.exitCode = exitCode;
    } catch {
      console.error(
        'Shutdown incomplete. Keep lock directories until remaining processes are inspected.',
      );
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  // Unexpected exceptions terminate rather than continuing with inconsistent state.
  process.on('uncaughtException', () => {
    console.error('Unexpected server failure; shutting down.');
    void shutdown(1);
  });
  process.on('unhandledRejection', () => {
    console.error('Unexpected async failure; shutting down.');
    void shutdown(1);
  });
  const port = process.env.AI_OFFICE_PORT === undefined ? 4310 : Number(process.env.AI_OFFICE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('AI_OFFICE_PORT must be an integer from 0 to 65535.');
  const address = await app.listen({ host: '127.0.0.1', port });
  console.log(`AI Office: ${address} (API); development dashboard: http://127.0.0.1:5173`);
} catch (error) {
  store?.close();
  await release();
  throw error;
}
