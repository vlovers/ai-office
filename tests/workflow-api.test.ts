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
    const unknown = await send('POST', '/api/workflows', {
      repositoryId: repository.id,
      coderAgentId: 'missing',
      reviewerAgentId: 'codex-2',
    });
    expect(unknown.statusCode).toBe(400);
    expect(env.store.tasks()).toEqual([]);
  } finally {
    if (app) await app.close();
    await env.cleanup();
  }
});
