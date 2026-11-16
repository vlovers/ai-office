// Week 1 execution-safety regressions. Unless a test is marked NATIVE, the isolation gate is
// SIMULATED (an injected verifier): these tests prove the gate is mandatory, cached safely and
// covered by the deadline; tests/qa-runner.test.ts and tests/native-sandbox.ts prove the OS sandbox.
import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, utimes, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nativeIsolationAvailable, sandbox, simulatedIsolationCalls, until } from './helpers.js';
import { validateRepository, repositoryLeaseDirectories } from '../src/server/repositories.js';
import { TaskManager } from '../src/server/manager.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import {
  cachedIsolationVerifier,
  type IsolationVerifier,
} from '../src/server/providers/native-isolation.js';
import { acquireLocks, leaseRoot, ResourceLockedError } from '../src/server/lock.js';
import { UncertainCleanupError } from '../src/server/process-group.js';
import { AppError } from '../src/server/errors.js';
import type { AgentProvider, ProviderEvent } from '../src/server/providers/types.js';
import { AGENT_IDS, type ExecutionMode, type Repository } from '../src/shared/types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const terminal = ['completed', 'stopped', 'failed', 'interrupted'];

interface Call {
  executable: string;
  version: string;
  fresh: boolean;
}
function recorder(behaviour?: (signal: AbortSignal) => Promise<void>) {
  const calls: Call[] = [];
  const isolation: IsolationVerifier = async (executable, version, signal, options) => {
    calls.push({ executable, version, fresh: Boolean(options?.fresh) });
    await behaviour?.(signal);
  };
  return { calls, isolation };
}
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

async function harness(
  options: { isolation?: IsolationVerifier; timeoutMs?: number; providers?: AgentProvider[] } = {},
) {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const providers =
    options.providers ??
    AGENT_IDS.map(
      (id) =>
        new CodexProvider({
          home: join(env.root, 'safety', id),
          auth: env.auth,
          isolation: options.isolation ?? recorder().isolation,
        }),
    );
  const manager = new TaskManager(env.store, providers, env.auth, undefined, options.timeoutMs);
  cleanups.push(() =>
    // A quarantined agent correctly refuses a clean shutdown; that is asserted in its test.
    manager.shutdown().catch((error) => {
      if (!(error instanceof UncertainCleanupError)) throw error;
    }),
  );
  const repository = env.store.register(await validateRepository(env.repository));
  const create = (prompt = 'Review README', executionMode?: ExecutionMode) =>
    env.store.createTask({
      repositoryId: repository.id,
      agentId: 'codex-1',
      prompt,
      title: 'Safety',
      ...(executionMode ? { executionMode } : {}),
    });
  const settle = (id: string, timeout = 15000) =>
    until(
      () => env.store.task(id)!,
      (task) => terminal.includes(task.state),
      timeout,
    );
  const threads = (id: string) => env.store.events(id).filter((event) => event.kind === 'thread');
  return { env, manager, repository, create, settle, threads };
}
async function leasePaths(repository: Repository) {
  return (await repositoryLeaseDirectories(repository)).map((directory) =>
    join(leaseRoot(), createHash('sha256').update(directory).digest('hex')),
  );
}
async function expectLeaseReleased(repository: Repository) {
  const release = await acquireLocks(await leasePaths(repository), 'test probe');
  await release();
}

// ---------------------------------------------------------------- read-only isolation gate

it('verifies isolation before every ordinary read-only task (SIMULATED gate)', async () => {
  const gate = recorder();
  const { create, manager, settle, env } = await harness({ isolation: gate.isolation });
  const task = create();
  manager.start(task.id);
  const done = await settle(task.id);
  expect(done.state).toBe('completed');
  expect(gate.calls).toEqual([
    { executable: expect.any(String), version: env.inspection.version, fresh: false },
  ]);
});

it.skipIf(!nativeIsolationAvailable)(
  'NATIVE: an ordinary read-only task passes the real Codex sandbox probe before running',
  async () => {
    const env = await sandbox(); // default fixture providers use the native gate here
    cleanups.push(env.cleanup);
    const repository = env.store.register(await validateRepository(env.repository));
    const task = env.store.createTask({
      repositoryId: repository.id,
      agentId: 'codex-1',
      prompt: 'Review README',
      title: 'Native',
    });
    const calls = simulatedIsolationCalls.length;
    env.manager.start(task.id);
    const done = await until(
      () => env.store.task(task.id)!,
      (current) => terminal.includes(current.state),
      30000,
    );
    expect(done.state).toBe('completed');
    expect(simulatedIsolationCalls).toHaveLength(calls); // the simulated gate was not used
  },
  40000,
);

it('fails closed when isolation cannot be verified and never starts the provider', async () => {
  const gate = recorder(async () => {
    throw new Error('raw sandbox diagnostic SECRET_SHOULD_NOT_LEAK');
  });
  const { create, manager, settle, threads, repository } = await harness({
    isolation: gate.isolation,
  });
  const task = create();
  manager.start(task.id);
  const done = await settle(task.id);
  expect(done.state).toBe('failed');
  expect(done.error).toContain('Native sandbox capability verification failed');
  expect(done.error).not.toContain('SECRET_SHOULD_NOT_LEAK');
  expect(done.result).toBe('');
  expect(threads(task.id)).toEqual([]); // the CLI never ran
  await expectLeaseReleased(repository);
});

it('gates missing modes and workflow snapshots, and never probes isolated writes', async () => {
  const gate = recorder();
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const provider = new CodexProvider({
    home: join(env.root, 'gate'),
    auth: env.auth,
    isolation: gate.isolation,
  });
  const drain = async (session: Awaited<ReturnType<CodexProvider['startSession']>>) => {
    await provider.executeTask(session, 'Review README');
    const events: ProviderEvent[] = [];
    for await (const event of provider.streamEvents(session)) events.push(event);
    await provider.stopSession(session);
    return events;
  };
  // No execution mode at all: treated as read-only (fail closed).
  expect((await drain(await provider.startSession(env.repository))).at(-1)?.kind).toBe('progress');
  expect(gate.calls.map((call) => call.fresh)).toEqual([false]);
  // Workflow snapshot stages keep a fresh, uncached proof per dispatch.
  const snapshot = await provider.startSession(env.repository);
  snapshot.executionMode = 'read-only';
  snapshot.verifiedReadOnly = true;
  await drain(snapshot);
  expect(gate.calls.map((call) => call.fresh)).toEqual([false, true]);
  // A snapshot session can never be executed with write access.
  const escalated = await provider.startSession(env.repository);
  escalated.executionMode = 'write';
  escalated.verifiedReadOnly = true;
  await expect(provider.executeTask(escalated, 'x')).rejects.toThrow(
    'Read-only execution required',
  );
  // Isolated writes are confined by the workspace and write profile, not this probe.
  const write = await provider.startSession(env.repository);
  write.executionMode = 'write';
  await drain(write);
  expect(gate.calls).toHaveLength(2);
});

it('stops cleanly when cancelled while isolation verification is in progress', async () => {
  const gate = recorder(untilAborted);
  const { create, manager, settle, threads, repository } = await harness({
    isolation: gate.isolation,
  });
  const task = create();
  manager.start(task.id);
  await until(
    () => gate.calls.length,
    (count) => count === 1,
  );
  await manager.stop(task.id);
  const done = await settle(task.id);
  expect(done.state).toBe('stopped');
  expect(threads(task.id)).toEqual([]);
  await expectLeaseReleased(repository);
});

// ---------------------------------------------------------------- cached verifier

async function executableFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-isolation-cache-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o700);
  return executable;
}
it('caches only successful probes and re-probes when the runtime identity changes', async () => {
  const executable = await executableFixture();
  let probes = 0;
  let fail = false;
  const verify = cachedIsolationVerifier(async () => {
    probes++;
    if (fail) throw new AppError(409, 'probe failed');
  }, 60_000);
  const signal = new AbortController().signal;

  await verify(executable, '1.0.0', signal);
  await verify(executable, '1.0.0', signal);
  expect(probes).toBe(1); // cached success

  await verify(executable, '1.0.1', signal); // runtime version changed
  expect(probes).toBe(2);

  await writeFile(executable, '#!/bin/sh\n# replaced binary\n'); // executable identity changed
  await utimes(executable, new Date(), new Date(Date.now() + 5000));
  fail = true;
  await expect(verify(executable, '1.0.1', signal)).rejects.toThrow('probe failed');
  await expect(verify(executable, '1.0.1', signal)).rejects.toThrow('probe failed');
  expect(probes).toBe(4); // failures are never cached

  fail = false;
  await verify(executable, '1.0.1', signal, { fresh: true });
  await verify(executable, '1.0.1', signal, { fresh: true });
  expect(probes).toBe(6); // fresh proofs bypass the cache

  await expect(verify(join(executable, 'missing'), '1.0.1', signal)).rejects.toThrow(
    'could not be identified',
  );
});

it('expires cached proofs, shares concurrent probes and re-probes after restart', async () => {
  const executable = await executableFixture();
  let probes = 0;
  let finish!: () => void;
  const verify = cachedIsolationVerifier(
    () =>
      new Promise<void>((resolve) => {
        probes++;
        finish = resolve;
      }),
    50,
  );
  const signal = new AbortController().signal;
  const concurrent = [verify(executable, 'v', signal), verify(executable, 'v', signal)];
  await until(
    () => probes,
    (count) => count === 1,
  );
  finish();
  await Promise.all(concurrent);
  expect(probes).toBe(1);
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
  const expired = verify(executable, 'v', signal);
  await until(
    () => probes,
    (count) => count === 2,
  );
  finish();
  await expired;
  // A restarted server has no cache: the first read-only task re-proves isolation.
  const restarted = cachedIsolationVerifier(async () => {
    probes++;
  });
  await restarted(executable, 'v', signal);
  expect(probes).toBe(3);
});

it('lets one caller abort without cancelling a shared probe for others', async () => {
  const executable = await executableFixture();
  let finish!: () => void;
  const verify = cachedIsolationVerifier(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const leaving = new AbortController();
  const staying = verify(executable, 'v', new AbortController().signal);
  const cancelled = verify(executable, 'v', leaving.signal);
  leaving.abort();
  await expect(cancelled).rejects.toThrow('cancelled');
  finish();
  await expect(staying).resolves.toBeUndefined();
});

// ---------------------------------------------------------------- execution deadline

it('applies the deadline during preparation and fails without dispatching twice', async () => {
  const gate = recorder(untilAborted);
  const { create, manager, settle, threads, repository, env } = await harness({
    isolation: gate.isolation,
    timeoutMs: 400,
  });
  const task = create();
  manager.start(task.id);
  const done = await settle(task.id);
  expect(done.state).toBe('failed');
  expect(done.error).toBe('Task exceeded the 1 second runtime limit.');
  expect(threads(task.id)).toEqual([]);
  expect(env.store.queue()).toEqual([]);
  await expectLeaseReleased(repository);
  await new Promise((resolve) => {
    setTimeout(resolve, 600);
  });
  expect(gate.calls).toHaveLength(1); // never re-dispatched
  expect(env.store.task(task.id)!.state).toBe('failed');
});

it('applies the deadline during execution and reaps a provider that ignores SIGTERM', async () => {
  const { create, manager, settle, threads, repository } = await harness({ timeoutMs: 4000 });
  const task = create('WAIT_FIXTURE');
  manager.start(task.id);
  await until(
    () => threads(task.id),
    (events) => events.length > 0,
  );
  const done = await settle(task.id, 20000);
  expect(done.state).toBe('failed');
  expect(done.error).toBe('Task exceeded the 4 second runtime limit.');
  expect(manager.dashboard().agents[0]!.state).toBe('idle');
  await expectLeaseReleased(repository);
}, 30000);

it('fails a task whose provider exits unexpectedly instead of completing it', async () => {
  const { create, manager, settle, repository } = await harness();
  const task = create('EXIT_FIXTURE');
  manager.start(task.id);
  const done = await settle(task.id);
  expect(done.state).toBe('failed');
  expect(done.result).toBe('');
  await expectLeaseReleased(repository);
});

it('retains leases and quarantines the agent when cleanup is uncertain', async () => {
  const stub = (): AgentProvider => ({
    id: 'codex',
    capabilities: { cancellation: true, interactiveApprovals: false, writes: false },
    async startSession(repositoryPath) {
      return {
        id: randomUUID(),
        repositoryPath,
        threadId: null,
        binding: {
          mode: 'local-cli-chatgpt',
          contextId: 'synthetic',
          model: 'fixture-model',
          runtimeVersion: '0.162.1',
        },
      };
    },
    async resumeSession(repositoryPath, threadId, binding) {
      return { id: randomUUID(), repositoryPath, threadId, binding };
    },
    async executeTask() {},
    async *streamEvents() {
      yield { kind: 'thread', threadId: randomUUID() } satisfies ProviderEvent;
    },
    async stopSession() {
      throw new UncertainCleanupError();
    },
  });
  const { create, manager, settle, repository } = await harness({ providers: [stub(), stub()] });
  const paths = await leasePaths(repository);
  cleanups.push(async () => {
    for (const path of paths) await rm(path, { recursive: true, force: true });
  });
  const task = create();
  manager.start(task.id);
  const done = await settle(task.id);
  expect(done.state).toBe('interrupted');
  expect(done.error).toContain('cleanup could not be confirmed');
  await expect(acquireLocks(paths, 'probe')).rejects.toBeInstanceOf(ResourceLockedError);
  expect(manager.dashboard().agents[0]!.canStop).toBe(false);
  await expect(manager.stop(task.id)).rejects.toBeInstanceOf(UncertainCleanupError);
});

it('marks running work interrupted after restart and never re-dispatches it', async () => {
  const gate = recorder();
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-restart-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'metadata.sqlite');
  let store = new Store(path);
  const repository = store.register(await validateRepository(env.repository));
  const task = store.createTask({
    repositoryId: repository.id,
    agentId: 'codex-1',
    prompt: 'Review',
    title: 'Crash',
  });
  store.enqueue(task.id, 'local-cli-chatgpt'); // pins the submitted configuration
  store.claimQueued(task.id); // the server dies here, mid-run
  store.close();
  store = new Store(path);
  cleanups.push(async () => store.close());
  expect(store.task(task.id)!.state).toBe('interrupted');
  expect(store.queue()).toEqual([]);
  const providers = AGENT_IDS.map(
    (id) =>
      new CodexProvider({ home: join(directory, id), auth: env.auth, isolation: gate.isolation }),
  );
  const manager = new TaskManager(store, providers, env.auth);
  cleanups.push(() => manager.shutdown());
  manager.startQueue();
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  expect(gate.calls).toEqual([]);
  expect(store.task(task.id)!.state).toBe('interrupted');
});

// ---------------------------------------------------------------- dashboard loading

it('serves unchanged dashboards and workflows as 304 and invalidates on data changes', async () => {
  const { env, manager, create } = await harness();
  const app = await createApp(manager);
  cleanups.push(() => app.close());
  const get = (url: string, etag?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { host: '127.0.0.1:4310', ...(etag ? { 'if-none-match': etag } : {}) },
    });
  for (const url of ['/api/dashboard', '/api/workflows']) {
    const first = await get(url);
    expect(first.statusCode).toBe(200);
    const etag = String(first.headers.etag);
    const unchanged = await get(url, etag);
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
    expect(unchanged.headers['cache-control']).toBe('no-store');
    expect((await get(url, '"stale"')).statusCode).toBe(200);
  }
  const existing = create();
  const before = await get('/api/dashboard');
  const tag = String(before.headers.etag);
  env.store.addEvent(existing.id, 'progress', 'Events alone never change the dashboard.');
  expect((await get('/api/dashboard', tag)).statusCode).toBe(304);
  const task = create();
  const changed = await get('/api/dashboard', tag);
  expect(changed.statusCode).toBe(200);
  expect(JSON.parse(changed.body).tasks.map((item: { id: string }) => item.id)).toContain(task.id);
  // Live scheduler state changes the tag even when stored rows do not.
  const live = String(changed.headers.etag);
  manager.start(task.id);
  expect((await get('/api/dashboard', live)).statusCode).toBe(200);
  await until(
    () => env.store.task(task.id)!,
    (current) => terminal.includes(current.state),
  );
});

it('keeps dashboard content identical to an uncached rebuild and changes tags on restart', async () => {
  const { env, manager, create } = await harness();
  for (let index = 0; index < 25; index++) {
    const task = create(`Task ${index}`);
    env.store.pinConfiguration(task);
  }
  const cached = manager.dashboard();
  const restarted = new TaskManager(
    env.store,
    AGENT_IDS.map(
      (id) =>
        new CodexProvider({
          home: join(env.root, 'restarted', id),
          auth: env.auth,
          isolation: recorder().isolation,
        }),
    ),
    env.auth,
  );
  cleanups.push(() => restarted.shutdown());
  expect(restarted.dashboard()).toEqual(cached);
  expect(cached.tasks).toHaveLength(25);
  expect(cached.tasks.every((task) => task.configuration?.agentId === 'codex-1')).toBe(true);
  expect(restarted.dashboardView().etag).not.toBe(manager.dashboardView().etag);
});
