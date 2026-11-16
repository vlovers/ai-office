import { mkdtemp, writeFile, rm, chmod, realpath, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CodexProvider } from '../src/server/providers/codex.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth, type LocalInspection } from '../src/server/providers/codex-auth.js';
import { AGENT_IDS } from '../src/shared/types.js';
import { dirname } from 'node:path';
import {
  nativeCodex,
  nativeIsolationVerifier,
  type IsolationVerifier,
} from '../src/server/providers/native-isolation.js';

/** True where Codex's native sandbox can be probed (macOS, or Linux CI opting in). */
export const nativeIsolationAvailable =
  process.platform === 'darwin' || process.env.AI_OFFICE_NATIVE_TESTS === '1';
export const simulatedIsolationCalls: string[] = [];
/**
 * Read-only gate for fixture providers. macOS uses the REAL native probe through the
 * installed Codex binary. Elsewhere it is SIMULATED: it only records that the gate was
 * consulted. Simulated runs prove the gate is mandatory, not that the OS sandbox works.
 */
export const testIsolation: IsolationVerifier = nativeIsolationAvailable
  ? nativeIsolationVerifier
  : async (executable, _version, signal) => {
      signal.throwIfAborted();
      simulatedIsolationCalls.push(executable);
    };

let sharedFixture: Promise<string> | undefined;
/**
 * One immutable fixture CLI per test worker. Its identity is stable, so the REAL native
 * isolation probe runs once per worker and later read-only tasks exercise the production
 * cache path, instead of re-probing (9 sandboxed processes) in every test.
 */
function fixtureExecutable() {
  sharedFixture ??= (async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-fixture-')));
    const executable = join(directory, 'fixture.mjs');
    await writeFile(
      executable,
      `#!${process.execPath}\n${(await readFile(new URL('./fixtures/codex-fixture.mjs', import.meta.url), 'utf8')).replace('__NATIVE_CODEX_PATH__', JSON.stringify(nativeCodex))}`,
    );
    await chmod(executable, 0o500);
    process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    return executable;
  })();
  return sharedFixture;
}
export async function sandbox(existingRepository?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-test-')));
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
  const executable = await fixtureExecutable();
  const store = new Store(join(root, 'metadata.sqlite'));
  // Write scenarios explicitly opt fixture profiles into write preference; production defaults stay read-only.
  for (const profile of store.agents())
    store.editAgent(profile.id, profile.revision, {
      ...profile,
      maximumMode: 'write',
      model: 'fixture-model',
    });
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
    (id) => new CodexProvider({ home: join(root, 'workers', id), auth, isolation: testIsolation }),
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
      await removeTestTree(root);
    },
  };
}
export async function removeTestTree(root: string) {
  const unlock = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(join(path, entry.name));
  };
  await unlock(root);
  await rm(root, { recursive: true, force: true });
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
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value!)}`);
}
