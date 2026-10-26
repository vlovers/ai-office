import { expect, it } from 'vitest';
import { join } from 'node:path';
import { sandbox, until } from './helpers.js';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { AGENT_IDS } from '../src/shared/types.js';

async function seedResumableSession(env: Awaited<ReturnType<typeof sandbox>>) {
  const repository = env.store.register({
    path: env.repository,
    gitDir: join(env.repository, '.git'),
    name: 'restart session fixture',
  });
  const initial = env.store.createTask({
    repositoryId: repository.id,
    agentId: 'codex-1',
    title: 'Establish a read-only session',
    prompt: 'Inspect the disposable repository.',
    executionMode: 'read-only',
  });
  env.manager.start(initial.id);
  const completed = await until(
    () => env.store.task(initial.id)!,
    (task) => task.state === 'completed',
  );
  expect(completed.sessionId).toBeTruthy();
  const session = env.store.session(completed.sessionId!)!;
  expect(session.threadId).toBeTruthy();
  const binding = env.store.sessionBinding(session.id)!;
  expect(binding.contextId).toBeTruthy();
  return { repository, session, binding };
}

async function freshManager(env: Awaited<ReturnType<typeof sandbox>>, store: Store) {
  const auth = new CodexAuth({
    dataDir: env.root,
    inspectLocal: async () => env.inspection,
  });
  await auth.refresh();
  expect(auth.view().status).toBe('available');
  const providers = AGENT_IDS.map(
    (id) => new CodexProvider({ home: join(env.root, 'workers', id), auth }),
  );
  return new TaskManager(store, providers, auth);
}

it('resumes a saved session without Workflow replay', async () => {
  const env = await sandbox();
  let restarted: Store | undefined;
  let manager: TaskManager | undefined;
  try {
    const { repository, session, binding } = await seedResumableSession(env);
    const workflows = new WorkflowStore(env.store.db);
    const coder = env.store.agent('codex-1')!;
    const baseline = 'a'.repeat(40);
    const created = workflows.create({
      repositoryId: repository.id,
      baselineRevision: baseline,
      stages: [
        { kind: 'coder', agentId: coder.id, agentRevision: coder.revision, mode: 'write' },
        {
          kind: 'reviewer',
          agentId: 'codex-2',
          agentRevision: env.store.agent('codex-2')!.revision,
          mode: 'read-only',
        },
      ],
    });
    const approved = workflows.transition(created.id, created.version, {
      type: 'approve',
      revision: baseline,
    });
    const privileged = env.store.createTask({
      repositoryId: repository.id,
      agentId: coder.id,
      title: 'Never replay an approved write after a crash',
      prompt: 'WRITE_FIXTURE',
      executionMode: 'write',
    });
    const bound = workflows.bindApprovedTask(created.id, approved.version, privileged.id);
    workflows.enqueueApprovedTask(
      env.store,
      created.id,
      bound.version,
      privileged.id,
      'local-cli-chatgpt',
      baseline,
    );

    const continuation = env.store.createTask({
      repositoryId: repository.id,
      agentId: coder.id,
      title: 'Continue the original thread',
      prompt: 'Continue the saved read-only review.',
      executionMode: 'read-only',
    });
    env.store.enqueue(continuation.id, 'local-cli-chatgpt', session.id);
    const ordinary = env.store.createTask({
      repositoryId: repository.id,
      agentId: coder.id,
      title: 'Another unrelated task',
      prompt: 'Inspect the repository after the continuation.',
      executionMode: 'read-only',
    });
    env.store.enqueue(ordinary.id, 'local-cli-chatgpt');
    expect(env.store.queue().map((entry) => entry.taskId)).toEqual([
      privileged.id,
      continuation.id,
      ordinary.id,
    ]);

    // Keep the original SQLite connection open to simulate abrupt process death.
    restarted = new Store(join(env.root, 'metadata.sqlite'));
    manager = await freshManager(env, restarted);
    const recovered = new WorkflowStore(restarted.db).get(created.id)!;
    expect(recovered.state).toBe('blocked');
    expect(restarted.task(privileged.id)?.state).toBe('interrupted');
    expect(restarted.queue().map((entry) => entry.taskId)).toEqual([continuation.id, ordinary.id]);
    expect(restarted.queue()[0]?.resumeSessionId).toBe(session.id);
    expect(restarted.sessionBinding(session.id)).toEqual(binding);

    manager.startQueue();
    const continued = await until(
      () => restarted!.task(continuation.id)!,
      (task) => task.state === 'completed',
    );
    await until(
      () => restarted!.task(ordinary.id)!,
      (task) => task.state === 'completed',
    );
    expect(continued.sessionId).toBe(session.id);
    expect(continued.result).toContain('Resumed the saved review thread.');
    expect(restarted.session(session.id)?.threadId).toBe(session.threadId);
    expect(restarted.sessionBinding(session.id)).toEqual(binding);
    expect(restarted.sessions()).toHaveLength(2);
    expect(restarted.queue()).toEqual([]);
    expect(restarted.task(privileged.id)?.sessionId).toBeNull();
    expect(restarted.events(privileged.id).some((event) => event.kind === 'thread')).toBe(false);
    expect(new WorkflowStore(restarted.db).get(created.id)?.version).toBe(recovered.version);
    const threadEvent = (taskId: string) =>
      Number(
        restarted!.db
          .prepare("SELECT id FROM events WHERE task_id=? AND kind='thread' ORDER BY id LIMIT 1")
          .get(taskId)?.id,
      );
    expect(threadEvent(continuation.id)).toBeLessThan(threadEvent(ordinary.id));
    expect(JSON.stringify(manager.dashboard())).not.toContain(binding.contextId);
  } finally {
    await manager?.shutdown();
    restarted?.close();
    await env.cleanup();
  }
});

it('refuses a restarted session when its server-only execution binding has changed', async () => {
  const env = await sandbox();
  let restarted: Store | undefined;
  let manager: TaskManager | undefined;
  try {
    const { repository, session, binding } = await seedResumableSession(env);
    const continuation = env.store.createTask({
      repositoryId: repository.id,
      agentId: 'codex-1',
      title: 'Reject altered session context',
      prompt: 'Continue the saved review.',
      executionMode: 'read-only',
    });
    env.store.enqueue(continuation.id, 'local-cli-chatgpt', session.id);
    restarted = new Store(join(env.root, 'metadata.sqlite'));
    restarted.db
      .prepare('UPDATE session_bindings SET json=? WHERE session_id=?')
      .run(JSON.stringify({ ...binding, contextId: 'altered-context' }), session.id);
    manager = await freshManager(env, restarted);
    manager.startQueue();
    const failed = await until(
      () => restarted!.task(continuation.id)!,
      (task) => task.state === 'failed',
    );
    expect(failed.error).toContain('Saved session execution context changed');
    expect(failed.sessionId).toBeNull();
    expect(restarted.sessions()).toHaveLength(1);
    expect(restarted.events(continuation.id).some((event) => event.kind === 'thread')).toBe(false);
    expect(restarted.queue()).toEqual([]);
  } finally {
    await manager?.shutdown();
    restarted?.close();
    await env.cleanup();
  }
});
