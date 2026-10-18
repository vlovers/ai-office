import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { CodexProvider } from '../src/server/providers/codex.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth, type LocalInspection } from '../src/server/providers/codex-auth.js';
import { AGENT_IDS } from '../src/shared/types.js';
import { dirname } from 'node:path';

export async function sandbox(existingRepository?: string) {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-test-'));
  const repository = existingRepository ?? join(root, 'example');
  if (!existingRepository) {
    execFileSync('/bin/mkdir', [repository]);
    execFileSync('/usr/bin/git', ['init', '--quiet', repository], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    await writeFile(join(repository, 'README.md'), '# Disposable example\n');
  }
  const executable = join(root, 'fixture.mjs');
  await writeFile(
    executable,
    `#!${process.execPath}\n${await readFile(new URL('./fixtures/codex-fixture.mjs', import.meta.url), 'utf8')}`,
  );
  await chmod(executable, 0o700);
  const store = new Store(join(root, 'metadata.sqlite'));
  // Write scenarios explicitly opt fixture profiles into write preference; production defaults stay read-only.
  for (const profile of store.agents())
    store.editAgent(profile.id, profile.revision, { ...profile, maximumMode: 'write' });
  const inspection: LocalInspection = {
    account: 'chatgpt',
    executable,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(root, 'cli-home'),
      CODEX_HOME: join(root, 'cli-home'),
    },
    version: '0.162.1',
    models: [{ model: 'fixture-model', isDefault: true }],
  };
  const auth = new CodexAuth({ dataDir: root, inspectLocal: async () => inspection });
  await auth.refresh();
  const providers = AGENT_IDS.map(
    (id) => new CodexProvider({ home: join(root, 'workers', id), auth }),
  );
  const provider = providers[0]!;
  const manager = new TaskManager(store, providers, auth);
  return {
    root,
    repository,
    store,
    provider,
    providers,
    manager,
    auth,
    inspection,
    executable,
    async cleanup() {
      await manager.shutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function until<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value!)}`);
}
