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
    expect(thread.threadId).toMatch(/^00000000-0000-4000-8000-[a-f0-9]{12}$/);
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

it('smoke: two assigned agents stream independently and Stop A leaves B running', async () => {
  const env = await sandbox();
  const other = await sandbox();
  const app = await createApp(env.manager);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const base = (await app.listen({ host: '127.0.0.1', port: 0 })) + '/api';
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json() as Promise<T>;
    };
    const repoA = await post<Repository>('/repositories', { path: env.repository });
    const repoB = await post<Repository>('/repositories', { path: other.repository });
    const a = await post<Task>('/tasks', {
      repositoryId: repoA.id,
      agentId: 'codex-1',
      title: 'Agent A',
      prompt: 'WAIT_FIXTURE',
    });
    const b = await post<Task>('/tasks', {
      repositoryId: repoB.id,
      agentId: 'codex-2',
      title: 'Agent B',
      prompt: 'WAIT_FIXTURE',
    });
    for (const task of [a, b]) {
      const stream = await fetch(`${base}/tasks/${task.id}/stream`, { signal: controller.signal });
      expect(stream.headers.get('content-type')).toBe('text/event-stream');
      readers.push(stream.body!.getReader());
    }
    await Promise.all([post(`/tasks/${a.id}/start`, {}), post(`/tasks/${b.id}/start`, {})]);
    const readProgress = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      let text = '';
      while (!text.includes('Waiting for Stop')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    };
    const [eventsA, eventsB] = await Promise.all(readers.map(readProgress));
    expect(eventsA).toContain(a.id);
    expect(eventsA).not.toContain(b.id);
    expect(eventsB).toContain(b.id);
    expect(eventsB).not.toContain(a.id);
    await post(`/tasks/${a.id}/stop`, {});
    expect(env.store.task(a.id)?.state).toBe('stopped');
    expect(env.store.task(b.id)?.state).toBe('running');
    await post(`/tasks/${b.id}/stop`, {});
    const dashboard = await (await fetch(`${base}/dashboard`)).json();
    expect(dashboard.agents).toHaveLength(2);
    expect(dashboard.concurrency).toBe(2);
    expect(JSON.stringify(dashboard)).not.toContain('contextId');
    expect(JSON.stringify(dashboard)).not.toContain('owner.json');
  } finally {
    clearTimeout(timeout);
    for (const reader of readers) await reader.cancel().catch(() => {});
    controller.abort();
    await app.close();
    await env.cleanup();
    await other.cleanup();
  }
});

it('smoke: shutting down with an active task and open SSE never writes after end', async () => {
  const env = await sandbox();
  const app = await createApp(env.manager);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(address + '/api' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const repo = await post('/repositories', { path: env.repository });
    const task = await post('/tasks', {
      repositoryId: repo.id,
      agentId: 'codex-1',
      title: 'Shutdown fixture',
      prompt: 'WAIT_FIXTURE',
    });
    await post(`/tasks/${task.id}/start`, {});
    await until(
      () => env.store.task(task.id),
      (task) => task?.state === 'running',
    );
    const response = await fetch(address + `/api/tasks/${task.id}/stream`);
    reader = response.body!.getReader();
    await reader.read();
    await app.close();
    expect(['stopped', 'interrupted']).toContain(env.store.task(task.id)?.state);
    while (!(await reader.read()).done) {
      /* Drain the ended stream. */
    }
  } finally {
    await reader?.cancel();
    await app.close();
    await env.cleanup();
  }
});
