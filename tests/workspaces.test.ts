import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  realpath,
  rm,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workspaces } from '../src/server/workspaces.js';
import { validateRepository, git } from '../src/server/repositories.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { createApp } from '../src/server/app.js';
import { sandbox, until } from './helpers.js';
import type { WorkspaceReview } from '../src/shared/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function commit(path: string) {
  execFileSync('/usr/bin/git', [
    '-C',
    path,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'add',
    '.',
  ]);
  execFileSync('/usr/bin/git', [
    '-C',
    path,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Fixture',
  ]);
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-write-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'repository');
  await mkdir(path);
  execFileSync('/usr/bin/git', ['init', '-q', path]);
  await writeFile(join(path, 'README.md'), 'original\n');
  await writeFile(join(path, 'deleted.txt'), 'delete me\n');
  commit(path);
  const repository = {
    ...(await validateRepository(path)),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const service = new Workspaces({
    authorizedRoot: root,
    workspaceRoot: join(root, 'worktrees'),
    commands: {
      pass: ['/bin/sh', '-c', 'printf verified'],
      fail: ['/bin/sh', '-c', 'printf failure >&2; exit 3'],
      timeout: ['/bin/sleep', '10'],
      output: ['/usr/bin/yes'],
    },
    verificationTimeoutMs: 100,
  });
  return { root, path, repository, service };
}
it('uses real Git for added, modified, deleted and committed diffs; protects primary checkout', async () => {
  const { service, repository, path } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  await writeFile(join(workspace.path, 'README.md'), 'changed\n');
  await rm(join(workspace.path, 'deleted.txt'));
  await writeFile(join(workspace.path, 'new file.txt'), 'new\n');
  let review = await service.review(repository, workspace);
  expect(review.files.map((f) => f.path).sort()).toEqual([
    'README.md',
    'deleted.txt',
    'new file.txt',
  ]);
  expect(review.diff).toContain('-original');
  expect(review.diff).toContain('+changed');
  expect(review.diff).toContain('+new');
  commit(workspace.path);
  review = await service.review(repository, workspace);
  expect(review.files).toHaveLength(3);
  expect(review.diff).toContain('+new');
  expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('original\n');
  expect(await git(path, ['status', '--porcelain'])).toBe('');
  await expect(service.reject(repository, workspace)).rejects.toThrow('contains commits');
});
it('rejects only its owned uncommitted worktree, retaining its branch and unrelated changes', async () => {
  const { service, repository, path } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  const other = await service.create(repository, randomUUID());
  await writeFile(join(workspace.path, 'README.md'), 'discard');
  await writeFile(join(workspace.path, 'untracked'), 'discard');
  await writeFile(join(other.path, 'unrelated'), 'preserve');
  await writeFile(join(path, 'local'), 'preserve');
  expect((await service.reject(repository, workspace)).decision).toBe('rejected');
  await expect(lstat(workspace.path)).rejects.toThrow();
  expect(await git(path, ['rev-parse', `refs/heads/${workspace.branch}`])).toContain(
    workspace.base,
  );
  expect(await readFile(join(other.path, 'unrelated'), 'utf8')).toBe('preserve');
  expect(await readFile(join(path, 'local'), 'utf8')).toBe('preserve');
});
it('fails safely for conflicting paths/branches, unauthorized roots, traversal and symlinks', async () => {
  const { service, repository, root, path } = await fixture();
  const id = randomUUID();
  await service.create(repository, id);
  await expect(service.create(repository, id)).rejects.toThrow('already exists');
  const branchId = randomUUID();
  await git(path, ['branch', `ai-office/${branchId}`]);
  await expect(service.create(repository, branchId)).rejects.toThrow('branch already exists');
  await expect(service.create(repository, '../escape')).rejects.toThrow('identifier');
  await expect(
    new Workspaces({
      authorizedRoot: join(root, 'worktrees'),
      workspaceRoot: join(root, 'elsewhere'),
    }).create(repository, randomUUID()),
  ).rejects.toThrow('outside');
  const linked = join(root, 'linked');
  await symlink(join(root, 'worktrees'), linked);
  await expect(
    new Workspaces({ authorizedRoot: root, workspaceRoot: linked }).create(
      repository,
      randomUUID(),
    ),
  ).rejects.toThrow('symlinks');
  await expect(
    new Workspaces({ authorizedRoot: root, workspaceRoot: join(path, 'nested') }).create(
      repository,
      randomUUID(),
    ),
  ).rejects.toThrow('separate');
  await expect(
    service.reject(repository, { ...(await service.create(repository, randomUUID())), path }),
  ).rejects.toThrow('ownership');
});
it('withholds sensitive files and never follows untracked symlink escapes', async () => {
  const { service, repository, root } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  await writeFile(join(root, 'outside'), 'PRIVATE_MARKER');
  await symlink(join(root, 'outside'), join(workspace.path, 'link'));
  await writeFile(join(workspace.path, '.env'), 'SECRET_MARKER');
  const review = await service.review(repository, workspace);
  expect(review.diff).not.toContain('PRIVATE_MARKER');
  expect(review.diff).not.toContain('SECRET_MARKER');
});
it('preserves a worktree after identity changes, kept decisions and failed cleanup', async () => {
  const { service, repository } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  await expect(service.reject(repository, { ...workspace, decision: 'kept' })).rejects.toThrow(
    'pending',
  );
  await git(workspace.path, ['checkout', '--detach']);
  await expect(service.reject(repository, workspace)).rejects.toThrow();
  expect(await lstat(workspace.path)).toBeDefined();
  await git(workspace.path, ['checkout', workspace.branch]);
  await git(repository.path, ['worktree', 'lock', workspace.path]);
  await expect(service.reject(repository, workspace)).rejects.toThrow('Cleanup failed');
  expect(await lstat(workspace.path)).toBeDefined();
});
it('bounds configured verification and reports failures without inheriting secrets', async () => {
  const { service, repository } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  expect((await service.verify(repository, workspace, 'pass')).verification).toMatchObject({
    passed: true,
    output: 'verified',
  });
  expect((await service.verify(repository, workspace, 'fail')).verification).toMatchObject({
    passed: false,
    output: 'failure',
  });
  expect((await service.verify(repository, workspace, 'timeout')).verification?.passed).toBe(false);
  expect(
    (await service.verify(repository, workspace, 'output')).verification?.output.length,
  ).toBeLessThan(129000);
  await expect(service.verify(repository, workspace, '/bin/rm')).rejects.toThrow('configured');
});
it('requires confirmation, runs the SDK fixture in isolation and persists review/resume after restart', async () => {
  const env = await sandbox();
  cleanup.push(env.cleanup);
  await writeFile(join(env.repository, 'deleted.txt'), 'delete');
  commit(env.repository);
  const root = await realpath(env.root);
  const service = new Workspaces({ authorizedRoot: root, workspaceRoot: join(root, 'worktrees') });
  let store = env.store;
  let manager = new TaskManager(store, env.providers, env.auth, undefined, undefined, service);
  cleanup.push(async () => {
    await manager.shutdown();
    if (store !== env.store) store.close();
  });
  const repo = store.register(await validateRepository(env.repository));
  const task = store.createTask({
    repositoryId: repo.id,
    title: 'Write',
    prompt: 'WRITE_FIXTURE',
    executionMode: 'write',
  });
  expect(() => manager.start(task.id)).toThrow('Confirm');
  manager.start(task.id, undefined, true);
  await until(
    () => store.task(task.id),
    (t) => t?.state === 'completed',
  );
  const completed = store.task(task.id)!;
  const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
  expect(review.files).toHaveLength(3);
  expect(review.diff).toContain('+Modified by fixture');
  expect(await readFile(join(env.repository, 'README.md'), 'utf8')).toBe('# Disposable example\n');
  const session = store.session(completed.sessionId!)!;
  expect(session.workspaceId).toBe(completed.workspaceId);
  await manager.shutdown();
  store.close();
  store = new Store(join(env.root, 'metadata.sqlite'));
  manager = new TaskManager(store, env.providers, env.auth, undefined, undefined, service);
  expect(store.workspace(completed.workspaceId!)?.decision).toBe('pending');
  const resumed = store.createTask({
    repositoryId: repo.id,
    title: 'Resume',
    prompt: 'Inspect',
    executionMode: 'write',
  });
  manager.start(resumed.id, session.id, true);
  await until(
    () => store.task(resumed.id),
    (t) => t?.state === 'completed',
  );
  expect(store.task(resumed.id)?.workspaceId).toBe(completed.workspaceId);
  await manager.reviewOperation(task.id, 'keep');
  expect(store.workspace(completed.workspaceId!)?.decision).toBe('kept');
  await expect(manager.reviewOperation(task.id, 'reject')).rejects.toThrow('pending');
});
it('retains review after failed execution and stop, and recovers unfinished write metadata', async () => {
  const env = await sandbox();
  cleanup.push(env.cleanup);
  commit(env.repository);
  const root = await realpath(env.root);
  const service = new Workspaces({ authorizedRoot: root, workspaceRoot: join(root, 'worktrees') });
  const manager = new TaskManager(
    env.store,
    env.providers,
    env.auth,
    undefined,
    undefined,
    service,
  );
  cleanup.push(() => manager.shutdown());
  const repo = env.store.register(await validateRepository(env.repository));
  for (const prompt of ['FAIL_FIXTURE', 'WAIT_FIXTURE']) {
    const task = env.store.createTask({
      repositoryId: repo.id,
      title: prompt,
      prompt,
      executionMode: 'write',
    });
    manager.start(task.id, undefined, true);
    if (prompt === 'WAIT_FIXTURE') {
      await until(
        () => env.store.session(env.store.task(task.id)?.sessionId ?? '')?.threadId,
        Boolean,
      );
      await manager.stop(task.id);
    }
    await until(
      () => env.store.task(task.id),
      (t) => ['failed', 'stopped'].includes(t!.state),
    );
    expect(
      ((await manager.reviewOperation(task.id, 'review')) as WorkspaceReview).workspace.decision,
    ).toBe('pending');
  }
  const app = await createApp(manager);
  cleanup.push(() => app.close());
  const task = env.store.tasks()[0]!;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/review`,
        headers: { host: '127.0.0.1:4310' },
        payload: { action: 'reject' },
      })
    ).statusCode,
  ).toBe(400);
  env.store.updateTask(task.id, { state: 'running' });
  const recovered = new Store(join(root, 'metadata.sqlite'));
  cleanup.push(async () => recovered.close());
  expect(recovered.task(task.id)?.state).toBe('interrupted');
  expect(recovered.task(task.id)?.workspaceId).toBe(task.workspaceId);
});

it('refuses nested Git deletion and leaves invalid workspace roots untouched', async () => {
  const { service, repository, path } = await fixture();
  await expect(
    new Workspaces({ authorizedRoot: path, workspaceRoot: join(path, 'must-not-create') }).create(
      repository,
      randomUUID(),
    ),
  ).rejects.toThrow('separate');
  await expect(lstat(join(path, 'must-not-create'))).rejects.toThrow();
  const workspace = await service.create(repository, randomUUID());
  const nested = join(workspace.path, 'unrelated-repository');
  await mkdir(nested);
  execFileSync('/usr/bin/git', ['init', '-q', nested]);
  await writeFile(join(nested, 'preserve'), 'unrelated');
  await expect(service.reject(repository, workspace)).rejects.toThrow('Nested Git');
  expect(await readFile(join(nested, 'preserve'), 'utf8')).toBe('unrelated');
});
