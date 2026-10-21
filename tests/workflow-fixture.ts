import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { sandbox, until } from './helpers.js';
import { validateRepository } from '../src/server/repositories.js';
import { TaskManager } from '../src/server/manager.js';
import { Workspaces } from '../src/server/workspaces.js';
import { createApp } from '../src/server/app.js';
import type { Workflow } from '../src/server/workflows.js';

export async function workflowFixture(
  options: {
    appFactory?: typeof createApp;
    reviewerInstructions?: string;
    commands?: Record<string, string[]>;
    timeoutMs?: number;
  } = {},
) {
  const env = await sandbox();
  const profile = env.store.agent('codex-2')!;
  env.store.editAgent(profile.id, profile.revision, {
    ...profile,
    maximumMode: 'read-only',
    instructions: options.reviewerInstructions ?? '',
  });
  await writeFile(join(env.repository, 'deleted.txt'), 'delete me\n');
  execFileSync('/usr/bin/git', ['-C', env.repository, 'add', '.']);
  execFileSync('/usr/bin/git', [
    '-C',
    env.repository,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'baseline',
  ]);
  const repository = env.store.register(await validateRepository(env.repository));
  const workspaces = new Workspaces({
    authorizedRoot: env.root,
    workspaceRoot: join(env.root, 'worktrees'),
    commands: options.commands ?? {
      source: [
        '/bin/sh',
        '-c',
        'test "$(cat README.md)" = "Modified by fixture" && test -f added.txt && test ! -e deleted.txt && echo "QA assertions passed"',
      ],
    },
    verificationTimeoutMs: options.timeoutMs ?? 3000,
    allowHostVerification: false,
  });
  const manager = new TaskManager(
    env.store,
    env.providers,
    env.auth,
    undefined,
    undefined,
    workspaces,
  );
  const app = await (options.appFactory ?? createApp)(manager);
  const send = (method: 'POST' | 'GET', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        host: `127.0.0.1:${(app.server.address() as { port?: number } | null)?.port ?? 4310}`,
        'content-type': 'application/json',
      },
      ...(payload ? { payload } : {}),
    });
  const result = await send('POST', '/api/workflows', {
    repositoryId: repository.id,
    coderAgentId: 'codex-1',
    reviewerAgentId: 'codex-2',
    qaAgentId: 'codex-2',
  });
  assert.equal(result.statusCode, 201, result.body);
  let workflow = result.json<Workflow>();
  const url = '/api/workflows/' + workflow.id;
  const get = async () => (await send('GET', url)).json<Workflow>();
  const post = async (action: string, extra: Record<string, unknown> = {}, expected = 200) => {
    const current = await get();
    const response = await send('POST', url + '/' + action, {
      version: current.version,
      confirmed: true,
      ...extra,
    });
    assert.equal(response.statusCode, expected, response.body);
    workflow = response.json().workflow ?? response.json();
    return workflow;
  };
  const prepare = async () => {
    await post('approve-initial');
    const task = env.store.createTask({
      repositoryId: repository.id,
      agentId: 'codex-1',
      executionMode: 'write',
      title: 'Workflow fixture',
      prompt: 'WRITE_FIXTURE',
    });
    await post('bind-task', { taskId: task.id });
    await post('submit-initial', { confirmedWrite: true }, 202);
    await until(
      () => env.store.task(task.id),
      (value) => ['completed', 'failed'].includes(value?.state ?? ''),
      20000,
    );
    assert.equal(
      env.store.task(task.id)?.state,
      'completed',
      JSON.stringify(env.store.events(task.id)),
    );
    workflow = await post('capture-coder-evidence');
    const revision = workflow.stages[0]!.evidence!.revision;
    await post('approve-coder-evidence', { revision });
    await post('approve-reviewer', { revision });
    await post('prepare-reviewer');
    return { task, revision, workflow: await get() };
  };
  return {
    ...env,
    manager,
    workspaces,
    app,
    repositoryRecord: repository,
    get,
    send,
    post,
    prepare,
    url,
    async cleanup() {
      await app.close();
      await manager.shutdown();
      await env.cleanup();
    },
  };
}
