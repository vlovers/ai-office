import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { sandbox, until } from './helpers.js';
import type { Repository, Task, AgentEvent } from '../src/shared/types.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { join } from 'node:path';

it('smoke: HTTP → SQLite → official SDK/CLI fixture → SSE → result → persisted resume', async () => {
  const env = await sandbox();
  let app = await createApp(env.manager);
  let currentStore = env.store;
  let base = '';
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json() as Promise<T>;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    base = (await app.listen({ host: '127.0.0.1', port: 0 })) + '/api';
    const repo = await post<Repository>('/repositories', { path: env.repository });
    const task = await post<Task>('/tasks', {
      repositoryId: repo.id,
      agentId: 'codex-1',
      title: 'Smoke review',
      prompt: 'Review the README.',
    });
    const stream = await fetch(`${base}/tasks/${task.id}/stream`);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    reader = stream.body!.getReader();
    await post(`/tasks/${task.id}/start`, {});
    const finished = await until(
      () => env.store.task(task.id)!,
      (t) => ['completed', 'failed'].includes(t.state),
    );
    expect(finished.state, finished.error ?? '').toBe('completed');
    expect(finished.result).toContain('Reviewed the disposable repository');
    expect(finished.changedFiles).toEqual(finished.baselineFiles);
    expect(finished.changedFiles).toEqual([{ path: 'README.md', status: '??' }]);
    const thread = env.store.session(finished.sessionId!)!;
    expect(thread.threadId).toBe('00000000-0000-4000-8000-000000000001');
    expect(thread.authMode).toBe('local-cli-chatgpt');
    expect(thread.model).toBe('fixture-model');
    let streamed = '';
    while (!streamed.includes('Task completed.')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    expect(streamed).toContain('thread');
    expect(streamed).toContain('Reviewed the disposable');
    const history = (await (await fetch(`${base}/tasks/${task.id}/events`)).json()) as AgentEvent[];
    const after = history[0]!.id;
    const replay = await fetch(`${base}/tasks/${task.id}/stream`, {
      headers: { 'Last-Event-ID': String(after) },
    });
    const replayReader = replay.body!.getReader();
    const replayed = new TextDecoder().decode((await replayReader.read()).value);
    expect(replayed).not.toContain(`id: ${after}\n`);
    expect(replayed).toContain('Turn completed.');
    await replayReader.cancel();
    await reader.cancel();
    reader = undefined;
    await app.close();
    currentStore.close();
    // New server, provider, auth service and SQLite connection, with the same data directory.
    currentStore = new Store(join(env.root, 'metadata.sqlite'));
    const auth = new CodexAuth({ dataDir: env.root, inspectLocal: async () => env.inspection });
    await auth.refresh();
    const provider = new CodexProvider({ home: join(env.root, 'worker-home'), auth });
    const manager = new TaskManager(currentStore, provider, auth);
    app = await createApp(manager);
    base = (await app.listen({ host: '127.0.0.1', port: 0 })) + '/api';
    expect(currentStore.sessionBinding(thread.id)?.mode).toBe('local-cli-chatgpt');
    const dashboard = await (await fetch(`${base}/dashboard`)).text();
    expect(dashboard).not.toContain('contextId');
    expect(dashboard).not.toContain(env.inspection.env.HOME);
    const next = await post<Task>('/tasks', {
      repositoryId: repo.id,
      agentId: 'codex-1',
      title: 'Continue review',
      prompt: 'Continue.',
    });
    await post(`/tasks/${next.id}/start`, { resumeSessionId: thread.id });
    const resumed = await until(
      () => currentStore.task(next.id)!,
      (t) => ['completed', 'failed'].includes(t.state),
    );
    expect(resumed.state, resumed.error ?? '').toBe('completed');
    expect(resumed.result).toContain('Resumed the saved review thread.');
    expect(resumed.sessionId).toBe(thread.id);
  } finally {
    await reader?.cancel();
    await app.close();
    currentStore.close();
    await env.cleanup();
  }
});
