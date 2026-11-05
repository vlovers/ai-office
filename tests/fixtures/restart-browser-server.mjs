// Disposable, fixture-only production server in a separate Node process.
// Never exposes a remote listener, provider credentials or write permissions.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [rootArg, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!rootArg || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Expected fixture data directory and loopback port');
const root = resolve(rootArg);
const base = resolve('dist/server');
const { Store } = await import(pathToFileURL(join(base, 'store.js')).href);
const { TaskManager } = await import(pathToFileURL(join(base, 'manager.js')).href);
const { CodexAuth } = await import(pathToFileURL(join(base, 'providers/codex-auth.js')).href);
const { CodexProvider } = await import(pathToFileURL(join(base, 'providers/codex.js')).href);
const { createApp } = await import(pathToFileURL(join(base, 'app.js')).href);
const store = new Store(join(root, 'metadata.sqlite'));
const auth = new CodexAuth({
  dataDir: root,
  inspectLocal: async () => ({
    account: 'chatgpt',
    executable: process.execPath,
    env: { PATH: '/usr/bin:/bin', HOME: join(root, 'cli-home'), CODEX_HOME: join(root, 'cli-home') },
    version: '0.162.1',
    models: [{ model: 'fixture-model', isDefault: true }],
  }),
});
await auth.refresh();
const providers = ['codex-1', 'codex-2'].map(
  (id) => new CodexProvider({ home: join(root, 'workers', id), auth }),
);
const manager = new TaskManager(store, providers, auth);
const app = await createApp(manager);
await app.listen({ host: '127.0.0.1', port });
process.send?.({ type: 'ready' });
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    store.close();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
