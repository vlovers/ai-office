import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.js';
import { validateRepository } from '../src/server/repositories.js';
import { createApp } from '../src/server/app.js';

it('creates pinned inert workflows from server Git HEAD and exposes inspection only', async () => {
  const env = await sandbox();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const repository = env.store.register(await validateRepository(env.repository));
    execFileSync('/usr/bin/git', ['-C', env.repository, 'add', 'README.md']);
    execFileSync('/usr/bin/git', [
      '-C',
      env.repository,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'baseline',
    ]);
    const expected = execFileSync('/usr/bin/git', ['-C', env.repository, 'rev-parse', 'HEAD'])
      .toString()
      .trim();
    app = await createApp(env.manager);
    const send = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app!.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
        ...(payload ? { payload } : {}),
      });
    const created = await send('POST', '/api/workflows', {
      repositoryId: repository.id,
      coderAgentId: 'codex-1',
      reviewerAgentId: 'codex-2',
    });
    expect(created.statusCode).toBe(201);
    const workflow = created.json();
    expect(workflow.baselineRevision).toBe(expected);
    expect(workflow.stages.map((s: { state: string }) => s.state)).toEqual([
      'awaiting_approval',
      'pending',
    ]);
    expect(env.store.tasks()).toEqual([]);
    expect(env.store.queue()).toEqual([]);
    expect((await send('GET', '/api/workflows')).json()).toHaveLength(1);
    expect((await send('GET', '/api/workflows/' + workflow.id)).json().id).toBe(workflow.id);
    expect(
      (await send('GET', '/api/workflows/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
    expect(
      (
        await send('POST', '/api/workflows/' + workflow.id + '/approve', {
          confirmed: true,
        })
      ).statusCode,
    ).toBe(404);
    const approvalPath = '/api/workflows/' + workflow.id + '/approve-initial';
    expect((await send('POST', approvalPath, { version: 0, confirmed: false })).statusCode).toBe(
      400,
    );
    const approved = await send('POST', approvalPath, { version: 0, confirmed: true });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().stages[0].state).toBe('ready');
    expect((await send('POST', approvalPath, { version: 0, confirmed: true })).statusCode).toBe(
      409,
    );
    expect(env.store.queue()).toEqual([]);
    expect(env.store.tasks()).toEqual([]);
    const coderTask = env.store.createTask({
      repositoryId: repository.id,
      agentId: 'codex-1',
      executionMode: 'write',
      title: 'Coder implementation',
      prompt: 'Implement example',
    });
    const bindingUrl = '/api/workflows/' + workflow.id + '/bind-task';
    const bound = await send('POST', bindingUrl, {
      version: approved.json().version,
      taskId: coderTask.id,
      confirmed: true,
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().stages[0].taskId).toBe(coderTask.id);
    expect(
      (
        await send('POST', bindingUrl, {
          version: approved.json().version,
          taskId: coderTask.id,
          confirmed: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(env.store.queue()).toEqual([]);
    expect(env.store.task(coderTask.id)?.state).toBe('queued');
    // A new workflow bound to the old SHA cannot be approved after a new commit.
    const stale = await send('POST', '/api/workflows', {
      repositoryId: repository.id,
      coderAgentId: 'codex-1',
      reviewerAgentId: 'codex-2',
    });
    expect(stale.statusCode).toBe(201);
    execFileSync('/usr/bin/git', [
      '-C',
      env.repository,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'new revision',
    ]);
    expect(
      (
        await send('POST', '/api/workflows/' + stale.json().id + '/approve-initial', {
          version: 0,
          confirmed: true,
        })
      ).statusCode,
    ).toBe(409);
    const unknown = await send('POST', '/api/workflows', {
      repositoryId: repository.id,
      coderAgentId: 'missing',
      reviewerAgentId: 'codex-2',
    });
    expect(unknown.statusCode).toBe(400);
    expect(env.store.tasks()).toHaveLength(1);
  } finally {
    if (app) await app.close();
    await env.cleanup();
  }
});
