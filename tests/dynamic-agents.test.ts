import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sandbox, until } from './helpers.js';
import { TaskManager } from '../src/server/manager.js';
import { validateRepository } from '../src/server/repositories.js';
import type {
  AgentProvider,
  ProviderSession,
  ProviderEvent,
} from '../src/server/providers/types.js';
import { validateAgentSettings } from '../src/server/agents.js';
import { createApp } from '../src/server/app.js';

it('runs more than two profiles with bounded capacity, fair FIFO heads, cancellation and task-local events', async () => {
  const envs = await Promise.all([sandbox(), sandbox(), sandbox()]);
  const env = envs[0]!;
  const calls: { profile: string; prompt: string; session: ProviderSession }[] = [];
  const releases = new Map<string, () => void>();
  const providers = new Set<AgentProvider>();
  function createProvider(profile: string): AgentProvider {
    const waits = new Map<string, Promise<void>>();
    const provider: AgentProvider = {
      id: 'codex',
      capabilities: { cancellation: true, writes: false, interactiveApprovals: false },
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
      async executeTask(session, prompt) {
        calls.push({ profile, prompt: prompt.split('\n').at(-1)!, session });
        waits.set(session.id, new Promise((resolve) => releases.set(session.id, resolve)));
      },
      async *streamEvents(session): AsyncIterable<ProviderEvent> {
        yield { kind: 'thread', threadId: session.threadId ?? randomUUID() };
        await waits.get(session.id);
        yield { kind: 'result', text: `Completed ${profile}` };
      },
      async stopSession(session) {
        releases.get(session.id)?.();
      },
    };
    providers.add(provider);
    return provider;
  }
  const manager = new TaskManager(
    env.store,
    env.providers,
    env.auth,
    undefined,
    undefined,
    undefined,
    { createProvider, concurrency: 2 },
  );
  try {
    const profiles = ['A', 'B', 'C'].map((name) =>
      env.store.createAgent(validateAgentSettings({ name, role: 'Review' })),
    );
    const repos = await Promise.all(
      envs.map(async (peer) => env.store.register(await validateRepository(peer.repository))),
    );
    const task = (index: number, title: string) =>
      env.store.createTask({
        repositoryId: repos[index]!.id,
        agentId: profiles[index]!.id,
        title,
        prompt: title,
      });
    const a = task(0, 'A first'),
      b = task(1, 'B first'),
      c = task(2, 'C first'),
      a2 = task(0, 'A second'),
      canceled = task(2, 'Canceled');
    manager.start(a.id);
    manager.start(b.id);
    manager.start(c.id);
    manager.start(a2.id);
    manager.start(canceled.id);
    expect(manager.dashboard().concurrency).toBe(2);
    expect(
      manager.dashboard().agents.filter((agent) => ['preparing', 'running'].includes(agent.state)),
    ).toHaveLength(2);
    await until(
      () => calls.length,
      (n) => n === 2,
    );
    expect(calls.map((call) => call.prompt).sort()).toEqual(['A first', 'B first']);
    expect(() => manager.start(a.id)).toThrow();
    await manager.stop(canceled.id);
    expect(env.store.task(canceled.id)?.state).toBe('stopped');
    releases.get(calls.find((call) => call.profile === profiles[0]!.id)!.session.id)!();
    await until(
      () => calls.length,
      (n) => n === 3,
    );
    expect(calls[2]!.prompt).toBe('C first');
    expect(env.store.task(a2.id)?.state).toBe('queued');
    releases.get(calls.find((call) => call.profile === profiles[1]!.id)!.session.id)!();
    await until(
      () => calls.length,
      (n) => n === 4,
    );
    expect(calls[3]!.prompt).toBe('A second');
    expect(providers.size).toBe(3);
    releases.get(calls[2]!.session.id)!();
    releases.get(calls[3]!.session.id)!();
    await until(
      () => env.store.tasks().filter((t) => t.state === 'completed').length,
      (n) => n === 4,
    );
    for (const t of [a, b, c, a2]) {
      expect(env.store.events(t.id).every((event) => event.taskId === t.id)).toBe(true);
      expect(env.store.taskConfiguration(t.id)?.agentId).toBe(t.agentId);
    }
    const session = env.store.task(a.id)!.sessionId!;
    const resume = task(0, 'Resume A');
    manager.start(resume.id, session);
    await until(
      () => calls.length,
      (n) => n === 5,
    );
    expect(calls[4]!.session.threadId).toBe(env.store.session(session)?.threadId);
    releases.get(calls[4]!.session.id)!();
    await until(
      () => env.store.task(resume.id)?.state,
      (state) => state === 'completed',
    );
    expect(env.store.task(resume.id)?.sessionId).toBe(session);
  } finally {
    await manager.shutdown();
    for (const peer of envs) await peer.cleanup();
  }
});

it('accepts registered opaque owners and rejects archived, unknown and injected assignments', async () => {
  const env = await sandbox();
  const app = await createApp(env.manager);
  try {
    const repo = env.store.register(await validateRepository(env.repository));
    const profile = env.store.createAgent(
      validateAgentSettings({ name: 'Dynamic', role: 'Review' }),
    );
    const input = { repositoryId: repo.id, agentId: profile.id, title: 'Review', prompt: 'review' };
    const post = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
        payload,
      });
    expect((await post(input)).statusCode).toBe(201);
    expect((await post({ ...input, agentId: randomUUID() })).statusCode).toBe(404);
    expect((await post({ ...input, agentId: '../../outside' })).statusCode).toBe(400);
    env.store.editAgent(profile.id, profile.revision, { archived: true });
    expect((await post(input)).statusCode).toBe(409);
  } finally {
    await app.close();
    await env.cleanup();
  }
});

it('recovers confirmed dynamic-profile queues with original settings after archival and restart', async () => {
  const env = await sandbox();
  let reopened: Store | undefined;
  let manager: TaskManager | undefined;
  try {
    const repo = env.store.register(await validateRepository(env.repository));
    const profile = env.store.createAgent(
      validateAgentSettings({ name: 'Persistent', role: 'Review', model: 'fixture-model' }),
    );
    const task = env.store.createTask({
      repositoryId: repo.id,
      agentId: profile.id,
      title: 'Recover',
      prompt: 'review',
    });
    env.store.enqueue(task.id, 'local-cli-chatgpt');
    const pin = env.store.taskConfiguration(task.id);
    env.store.editAgent(profile.id, profile.revision, { archived: true });
    await env.manager.shutdown();
    env.store.close();
    reopened = new Store(join(env.root, 'metadata.sqlite'));
    manager = new TaskManager(reopened, env.providers, env.auth, undefined, undefined, undefined, {
      createProvider: (id) =>
        new CodexProvider({ home: join(env.root, 'workers', id), auth: env.auth }),
      concurrency: 2,
    });
    manager.startQueue();
    const done = await until(
      () => reopened!.task(task.id)!,
      (t) => ['completed', 'failed'].includes(t.state),
    );
    expect(done.state, done.error ?? '').toBe('completed');
    expect(reopened.taskConfiguration(task.id)).toEqual(pin);
    expect(reopened.agent(profile.id)?.archived).toBe(true);
    expect(reopened.queue()).toEqual([]);
  } finally {
    await manager?.shutdown();
    reopened?.close();
    await env.cleanup();
  }
});
