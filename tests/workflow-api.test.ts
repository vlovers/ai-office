import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { sandbox, until } from './helpers.js';
import { readFile, writeFile } from 'node:fs/promises';
import { validateRepository } from '../src/server/repositories.js';
import { createApp } from '../src/server/app.js';
import { Workspaces } from '../src/server/workspaces.js';
import { TaskManager } from '../src/server/manager.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock } from '../src/server/lock.js';
import { repositoryLeaseDirectories } from '../src/server/repositories.js';

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
    const timeline = await send('GET', '/api/workflows/' + workflow.id + '/timeline');
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().version).toBe(0);
    expect(timeline.json().stages.map((stage: { status: string }) => stage.status)).toEqual([
      'awaiting_approval',
      'pending',
    ]);
    expect(timeline.json().stages[0].nextAction).toBe('approve-initial');
    expect(timeline.json().stages[1].nextAction).toBeNull();
    expect(timeline.json().downstreamExecutable).toBe(false);
    expect(
      (await send('GET', '/api/workflows/00000000-0000-4000-8000-000000000000/timeline'))
        .statusCode,
    ).toBe(404);
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
    // A previously approved/bound task must also reject dispatch after Git
    // advances. No Codex session, queue entry or workspace may be created.
    const submit = await send('POST', '/api/workflows/' + workflow.id + '/submit-initial', {
      version: bound.json().version,
      confirmed: true,
      confirmedWrite: true,
    });
    expect(submit.statusCode).toBe(409);
    expect(env.store.queue()).toEqual([]);
    expect(env.store.task(coderTask.id)?.state).toBe('queued');
    expect((await send('GET', '/api/workflows/' + workflow.id)).json().stages[0].state).toBe(
      'ready',
    );

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

it('submits an approved Coder exactly once through the TaskManager with isolated writes', async () => {
  const env = await sandbox();
  const workspaces = new Workspaces({
    authorizedRoot: env.root,
    workspaceRoot: join(env.root, 'worktrees'),
    commands: {},
    verificationTimeoutMs: 1000,
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
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const repository = env.store.register(await validateRepository(env.repository));
    await writeFile(join(env.repository, 'deleted.txt'), 'tracked fixture\n');
    execFileSync('/usr/bin/git', ['-C', env.repository, 'add', '.']);
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
    app = await createApp(manager);
    const send = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app!.inject({
        method,
        url,
        headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
        ...(payload ? { payload } : {}),
      });
    const create = await send('POST', '/api/workflows', {
      repositoryId: repository.id,
      coderAgentId: 'codex-1',
      reviewerAgentId: 'codex-2',
    });
    expect(create.statusCode).toBe(201);
    const workflow = create.json();
    const url = '/api/workflows/' + workflow.id;
    const approved = await send('POST', url + '/approve-initial', {
      version: workflow.version,
      confirmed: true,
    });
    expect(approved.statusCode).toBe(200);
    const task = env.store.createTask({
      repositoryId: repository.id,
      agentId: 'codex-1',
      title: 'Fixture implementation',
      prompt: 'WRITE_FIXTURE',
      executionMode: 'write',
    });
    const bound = await send('POST', url + '/bind-task', {
      version: approved.json().version,
      taskId: task.id,
      confirmed: true,
    });
    expect(bound.statusCode).toBe(200);
    expect(
      (
        await send('POST', '/api/tasks/' + task.id + '/start', {
          confirmedWrite: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(env.store.queue()).toEqual([]);
    const submitted = await send('POST', url + '/submit-initial', {
      version: bound.json().version,
      confirmed: true,
      confirmedWrite: true,
    });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json().workflow.stages[0].state).toBe('running');
    expect(
      (
        await send('POST', url + '/submit-initial', {
          version: bound.json().version,
          confirmed: true,
          confirmedWrite: true,
        })
      ).statusCode,
    ).toBe(409);
    expect((await send('GET', url)).json().stages[1].state).toBe('pending');
    const completed = await until(
      () => env.store.task(task.id),
      (value) => value?.state === 'completed' || value?.state === 'failed',
      15000,
    );
    expect(completed?.state).toBe('completed');
    expect(completed?.workspaceId).toBeTruthy();
    const blocked = await send('GET', url);
    expect(blocked.json().state).toBe('blocked');
    expect(blocked.json().stages[1].state).toBe('pending');
    const blockedTimeline = await send('GET', url + '/timeline');
    expect(blockedTimeline.statusCode).toBe(200);
    expect(blockedTimeline.json().stages[0].nextAction).toBe('capture-coder-evidence');
    expect(blockedTimeline.json().downstreamExecutable).toBe(false);
    expect(await readFile(join(env.repository, 'README.md'), 'utf8')).toBe(
      '# Disposable example\n',
    );
    // Another process holding the repository lease must prevent evidence
    // inspection and must not change the workflow's durable checkpoint.
    const completedWorkspace = env.store.workspace(completed!.workspaceId!);
    expect(completedWorkspace).toBeTruthy();
    const leaseDirectories = await repositoryLeaseDirectories(
      repository,
      completedWorkspace!.gitDir,
    );
    const leasePath = join(
      '/tmp',
      `ai-office-worktrees-${process.getuid?.() ?? 'local'}`,
      createHash('sha256').update(leaseDirectories[0]!).digest('hex'),
    );
    const releaseLease = await acquireLock(leasePath, 'external test lease');
    try {
      const conflict = await send('POST', url + '/capture-coder-evidence', {
        version: blocked.json().version,
        confirmed: true,
      });
      expect(conflict.statusCode).toBe(409);
      expect((await send('GET', url)).json().version).toBe(blocked.json().version);
    } finally {
      await releaseLease();
    }
    const evidence = await send('POST', url + '/capture-coder-evidence', {
      version: blocked.json().version,
      confirmed: true,
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().stages[0].evidence.fileCount).toBe(3);
    const fingerprint = evidence.json().stages[0].evidence.revision;
    const workspace = env.store.workspace(completed!.workspaceId!);
    expect(workspace).toBeTruthy();
    await writeFile(join(workspace!.path, 'README.md'), 'tampered after capture\n');
    const staleEvidence = await send('POST', url + '/approve-coder-evidence', {
      version: evidence.json().version,
      confirmed: true,
      revision: fingerprint,
    });
    expect(staleEvidence.statusCode).toBe(409);
    expect((await send('GET', url)).json().state).toBe('blocked');
    // Restoring the bytes is not sufficient: Review Center also fingerprints
    // workspace identity and metadata. A stale approval must remain denied.
    await writeFile(join(workspace!.path, 'README.md'), 'Modified by fixture\n');
    const restored = await send('POST', url + '/approve-coder-evidence', {
      version: evidence.json().version,
      confirmed: true,
      revision: fingerprint,
    });
    expect(restored.statusCode).toBe(409);
    expect((await send('GET', url)).json().stages[1].state).toBe('pending');
    // Refresh requires a new explicit human checkpoint. Previous evidence is
    // preserved for audit and cannot be used to approve the refreshed output.
    const refreshed = await send('POST', url + '/capture-coder-evidence', {
      version: evidence.json().version,
      confirmed: true,
      replace: true,
    });
    expect(refreshed.statusCode).toBe(200);
    const currentFingerprint = refreshed.json().stages[0].evidence.revision;
    expect(currentFingerprint).not.toBe(fingerprint);
    expect(refreshed.json().stages[0].supersededEvidence).toEqual([
      evidence.json().stages[0].evidence,
    ]);
    expect(refreshed.json().state).toBe('blocked');
    const refreshedTimeline = await send('GET', url + '/timeline');
    expect(refreshedTimeline.statusCode).toBe(200);
    expect(refreshedTimeline.json().version).toBe(refreshed.json().version);
    expect(refreshedTimeline.json().stages[0].nextAction).toBe('approve-coder-evidence');
    expect(refreshedTimeline.json().stages[0].evidenceRevision).toBe(currentFingerprint);
    expect(refreshedTimeline.json().downstreamExecutable).toBe(false);
    expect(
      (
        await send('POST', url + '/capture-coder-evidence', {
          version: refreshed.json().version,
          confirmed: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await send('POST', url + '/approve-coder-evidence', {
          version: refreshed.json().version,
          confirmed: true,
          revision: fingerprint,
        })
      ).statusCode,
    ).toBe(409);
    const released = await send('POST', url + '/approve-coder-evidence', {
      version: refreshed.json().version,
      confirmed: true,
      revision: currentFingerprint,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().stages[1].state).toBe('awaiting_approval');
    // Race two identical HTTP confirmations against one checkpoint.
    // Exactly one must win; the loser cannot repeat downstream authorization.
    const attempts = await Promise.all([
      send('POST', url + '/approve-reviewer', {
        version: released.json().version,
        confirmed: true,
        revision: currentFingerprint,
      }),
      send('POST', url + '/approve-reviewer', {
        version: released.json().version,
        confirmed: true,
        revision: currentFingerprint,
      }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const reviewer = attempts.find((response) => response.statusCode === 200)!;
    expect(reviewer.json().stages[1].state).toBe('ready');
    expect(reviewer.json().stages[1].taskId).toBeNull();
    const approvedTimeline = await send('GET', url + '/timeline');
    expect(approvedTimeline.statusCode).toBe(200);
    expect(approvedTimeline.json().stages[1].status).toBe('ready');
    expect(approvedTimeline.json().stages[1].nextAction).toBeNull();
    expect(approvedTimeline.json().downstreamExecutable).toBe(false);
    const handoffUrl = url + '/inspect-handoff';
    const handoff = await send('POST', handoffUrl, {
      version: reviewer.json().version,
      revision: currentFingerprint,
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json().snapshotCreated).toBe(false);
    expect(handoff.json().downstreamExecutable).toBe(false);
    expect(handoff.json().fileCount).toBe(3);
    expect(
      (
        await send('POST', handoffUrl, {
          version: released.json().version,
          revision: currentFingerprint,
        })
      ).statusCode,
    ).toBe(409);
    expect(env.store.queue()).toEqual([]);
    expect(env.store.queue()).toEqual([]);
  } finally {
    if (app) await app.close();
    await manager.shutdown();
    await env.cleanup();
  }
});
