import { expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { TaskManager } from '../src/server/manager.js';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { sandbox } from './helpers.js';

it('serves recovered Reviewer and QA checkpoints consistently through dashboard and workflow APIs', async () => {
  const env = await sandbox();
  const path = join(env.root, 'restart-dashboard.sqlite');
  let store = new Store(path);
  let manager: TaskManager | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const repository = store.register({
      path: '/disposable/restart-dashboard',
      gitDir: '/disposable/restart-dashboard/.git',
      name: 'restart-dashboard',
    });
    const coder = store.agent('codex-1')!;
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, coder.revision);
    const reviewer = store.agent('codex-2')!;
    const baseline = 'a'.repeat(40);
    const revision = 'b'.repeat(40);
    const workflows = new WorkflowStore(store.db);

    const startStage = (kind: 'reviewer' | 'qa', label: string) => {
      const created = workflows.create({
        repositoryId: repository.id,
        baselineRevision: baseline,
        stages: [
          { kind: 'coder', agentId: coder.id, agentRevision: coder.revision, mode: 'write' },
          {
            kind: 'reviewer',
            agentId: reviewer.id,
            agentRevision: reviewer.revision,
            mode: 'read-only',
          },
          { kind: 'qa', agentId: reviewer.id, agentRevision: reviewer.revision, mode: 'read-only' },
        ],
      });
      const approved = workflows.transition(created.id, created.version, {
        type: 'approve',
        revision: baseline,
      });
      const coderRunning = workflows.transition(created.id, approved.version, {
        type: 'start',
        taskId: `coder-${label}`,
        revision: baseline,
      });
      const coderDone = workflows.transition(created.id, coderRunning.version, {
        type: 'finish',
        taskId: `coder-${label}`,
        revision,
        succeeded: true,
      });
      const reviewerApproved = workflows.transition(created.id, coderDone.version, {
        type: 'approve',
        revision,
      });
      if (kind === 'reviewer') {
        const task = store.createTask({
          repositoryId: repository.id,
          agentId: reviewer.id,
          title: 'Reviewer awaiting restart',
          prompt: 'Review persisted checkpoint',
          executionMode: 'read-only',
        });
        const running = workflows.transition(created.id, reviewerApproved.version, {
          type: 'start',
          taskId: task.id,
          revision,
        });
        return { task, workflowId: running.id, version: running.version };
      }
      const reviewerRunning = workflows.transition(created.id, reviewerApproved.version, {
        type: 'start',
        taskId: `reviewer-${label}`,
        revision,
      });
      const reviewerDone = workflows.transition(created.id, reviewerRunning.version, {
        type: 'finish',
        taskId: `reviewer-${label}`,
        revision,
        succeeded: true,
      });
      const qaApproved = workflows.transition(created.id, reviewerDone.version, {
        type: 'approve',
        revision,
      });
      const task = store.createTask({
        repositoryId: repository.id,
        agentId: reviewer.id,
        title: `QA ${label}`,
        prompt: 'Verify persisted checkpoint',
        executionMode: 'read-only',
      });
      const running = workflows.transition(created.id, qaApproved.version, {
        type: 'start',
        taskId: task.id,
        revision,
      });
      return { task, workflowId: running.id, version: running.version };
    };

    const reviewerQueued = startStage('reviewer', 'queued');
    store.enqueue(reviewerQueued.task.id, 'local-cli-chatgpt');
    const ordinary = store.createTask({
      repositoryId: repository.id,
      title: 'Ordinary queued work',
      prompt: 'Unrelated task',
    });
    store.enqueue(ordinary.id, 'local-cli-chatgpt');
    const qaFailed = startStage('qa', 'failed');
    store.updateTask(qaFailed.task.id, { state: 'failed', error: 'QA failed before restart.' });
    const qaCompleted = startStage('qa', 'completed');
    store.updateTask(qaCompleted.task.id, {
      state: 'completed',
      result: 'Output not yet approved or checkpointed',
    });

    // Reopen the same SQLite file as a new backend would. Do not listen: the
    // read-only API contract must not need a live Codex provider or queue worker.
    store.close();
    store = new Store(path);
    manager = new TaskManager(store, env.providers, env.auth);
    app = await createApp(manager);
    const get = (url: string) =>
      app!.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4310' } });
    const post = (url: string, payload: unknown) =>
      app!.inject({
        method: 'POST',
        url,
        headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
        payload,
      });

    const dashboard = await get('/api/dashboard');
    expect(dashboard.statusCode).toBe(200);
    const view = dashboard.json();
    expect(view.queue.map((entry: { taskId: string }) => entry.taskId)).toEqual([ordinary.id]);
    const tasks = new Map(
      view.tasks.map((task: { id: string; state: string }) => [task.id, task.state]),
    );
    expect(tasks.get(reviewerQueued.task.id)).toBe('interrupted');
    expect(tasks.get(qaFailed.task.id)).toBe('failed');
    expect(tasks.get(qaCompleted.task.id)).toBe('completed');
    expect(tasks.get(ordinary.id)).toBe('queued');

    const cases = [
      { id: reviewerQueued.workflowId, stage: 1, status: 'interrupted', code: 'execution-interrupted' },
      { id: qaFailed.workflowId, stage: 2, status: 'failed', code: 'execution-failed' },
      { id: qaCompleted.workflowId, stage: 2, status: 'blocked', code: 'stage-blocked' },
    ] as const;
    for (const entry of cases) {
      const base = `/api/workflows/${entry.id}`;
      const workflow = await get(base);
      const timeline = await get(base + '/timeline');
      const diagnostics = await get(base + '/diagnostics');
      expect(workflow.statusCode).toBe(200);
      expect(timeline.statusCode).toBe(200);
      expect(diagnostics.statusCode).toBe(200);
      expect(workflow.json().state).toBe('blocked');
      expect(timeline.json().state).toBe('blocked');
      expect(timeline.json().stages[entry.stage].status).toBe(entry.status);
      expect(timeline.json().stages[entry.stage].nextAction).toBeNull();
      expect(timeline.json().downstreamExecutable).toBe(false);
      expect(diagnostics.json().findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: entry.code })]),
      );
      expect(
        (await post(base + '/approve-qa-result', {
          version: workflow.json().version,
          confirmed: true,
          digest: 'c'.repeat(64),
        })).statusCode,
      ).toBe(409);
    }
    const listed = await get('/api/workflows');
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().filter((workflow: { state: string }) => workflow.state === 'blocked'),
    ).toHaveLength(3);
    expect(store.queue().map((entry) => entry.taskId)).toEqual([ordinary.id]);

    await app.close();
    app = undefined;
    await manager.shutdown();
    manager = undefined;
    store.close();
    store = new Store(path);
    const again = new WorkflowStore(store.db);
    expect(again.get(reviewerQueued.workflowId)?.version).toBe(
      (await getVersion(reviewerQueued.workflowId, again)),
    );
    expect(store.queue().map((entry) => entry.taskId)).toEqual([ordinary.id]);
  } finally {
    await app?.close();
    await manager?.shutdown();
    store.close();
    await env.cleanup();
  }
});

function getVersion(id: string, workflows: WorkflowStore): number {
  return workflows.get(id)!.version;
}
