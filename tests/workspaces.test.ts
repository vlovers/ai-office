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
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workspaces } from '../src/server/workspaces.js';
import { validateRepository, git, repositoryLeaseDirectories } from '../src/server/repositories.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { acquireLock } from '../src/server/lock.js';
import type { AgentProvider } from '../src/server/providers/types.js';
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
    allowHostVerification: true,
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
  expect(
    (await service.reject(repository, workspace, await service.revision(repository, workspace)))
      .decision,
  ).toBe('rejected');
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
  await expect(
    service.reject(repository, workspace, await service.revision(repository, workspace)),
  ).rejects.toThrow('Cleanup failed');
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
  await manager.reviewOperation(
    task.id,
    'keep',
    undefined,
    ((await manager.reviewOperation(task.id, 'review')) as WorkspaceReview).revision,
  );
  expect(store.workspace(completed.workspaceId!)?.decision).toBe('kept');
  await expect(
    manager.reviewOperation(
      task.id,
      'reject',
      undefined,
      ((await manager.reviewOperation(task.id, 'review')) as WorkspaceReview).revision,
    ),
  ).rejects.toThrow('pending');
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

it('does not let wildcard filenames bypass sensitive diff filtering', async () => {
  const { service, repository, path } = await fixture();
  await writeFile(join(path, '.env'), 'FAKE_BASE\n');
  commit(path);
  const workspace = await service.create(repository, randomUUID());
  await writeFile(join(workspace.path, '.env'), 'FAKE_PRIVATE_AUDIT_MARKER\n');
  await writeFile(join(workspace.path, '*'), 'wildcard filename\n');
  expect((await service.review(repository, workspace)).diff).not.toContain(
    'FAKE_PRIVATE_AUDIT_MARKER',
  );
});
it('refuses ignored user files and nested bare repositories during rejection', async () => {
  const { service, repository, path } = await fixture();
  await writeFile(join(path, '.gitignore'), 'private.local\n');
  commit(path);
  const workspace = await service.create(repository, randomUUID());
  await writeFile(join(workspace.path, 'private.local'), 'preserve ignored user data');
  await expect(service.reject(repository, workspace)).rejects.toThrow('ignored');
  expect(await readFile(join(workspace.path, 'private.local'), 'utf8')).toBe(
    'preserve ignored user data',
  );
});
it('refuses nested bare Git repositories during rejection', async () => {
  const { service, repository } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  const bare = join(workspace.path, 'user-backup.git');
  execFileSync('/usr/bin/git', ['init', '--bare', '-q', bare]);
  await expect(service.reject(repository, workspace)).rejects.toThrow('Nested Git');
  expect(await lstat(join(bare, 'HEAD'))).toBeDefined();
});
it('refuses a replacement worktree even at the same path, branch and Git directory', async () => {
  const { service, repository } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  await git(repository.path, ['worktree', 'remove', workspace.path]);
  await git(repository.path, ['worktree', 'add', workspace.path, workspace.branch]);
  await writeFile(join(workspace.path, 'new-owner-data'), 'preserve replacement');
  await expect(service.reject(repository, workspace)).rejects.toThrow('identity');
  expect(await readFile(join(workspace.path, 'new-owner-data'), 'utf8')).toBe(
    'preserve replacement',
  );
});

it('requires a fresh revision for decisions and refuses changed files after review', async () => {
  const { service, repository } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  const review = await service.review(repository, workspace);
  await writeFile(join(workspace.path, 'editor-data.txt'), 'preserve edits after review');
  await expect(service.reject(repository, workspace, review.revision)).rejects.toThrow(
    'Refresh Git review',
  );
  expect(await readFile(join(workspace.path, 'editor-data.txt'), 'utf8')).toBe(
    'preserve edits after review',
  );
  await service.reject(
    repository,
    workspace,
    (await service.review(repository, workspace)).revision,
  );
});
it('disables host verification unless the operator explicitly opts in', async () => {
  const { service, repository } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  const disabled = new Workspaces({ ...service.options, allowHostVerification: false });
  expect((await disabled.review(repository, workspace)).commands).toEqual([]);
  await expect(disabled.verify(repository, workspace, 'pass')).rejects.toThrow(
    'Host verification is disabled',
  );
});
it('records creation intent before Git and keeps it attached if creation cannot finish', async () => {
  const { service, repository, root } = await fixture();
  const store = new Store(join(root, 'intent.sqlite'));
  cleanup.push(async () => store.close());
  const repo = store.register(repository);
  const task = store.createTask({
    repositoryId: repo.id,
    title: 'Intent',
    prompt: 'write',
    executionMode: 'write',
  });
  const workspaceId = randomUUID();
  // The intent is persisted before this callback creates a deliberate path conflict.
  await expect(
    service.create(repo, workspaceId, (intent) => {
      store.attachWorkspace(task.id, intent);
      execFileSync('/bin/mkdir', [intent.path]);
    }),
  ).rejects.toThrow('Could not create');
  expect(store.task(task.id)?.workspaceId).toBe(workspaceId);
  expect(store.workspace(workspaceId)?.operation).toBe('creating');
  store.close();
  const recovered = new Store(join(root, 'intent.sqlite'));
  cleanup.push(async () => recovered.close());
  expect(recovered.workspace(workspaceId)?.recoveryError).toContain(
    'Interrupted workspace creating',
  );
  expect(await lstat(join(service.options.workspaceRoot, workspaceId))).toBeDefined();
});
it('recovers interrupted rejection and verification without deleting or adopting resources', async () => {
  const { service, repository, root } = await fixture();
  const store = new Store(join(root, 'recover.sqlite'));
  cleanup.push(async () => store.close());
  const saved = [];
  for (const operation of ['rejecting', 'verifying'] as const) {
    const workspace = await service.create(repository, randomUUID());
    await writeFile(join(workspace.path, 'preserve.txt'), operation);
    store.saveWorkspace({ ...workspace, operation });
    saved.push(workspace);
  }
  store.close();
  const recovered = new Store(join(root, 'recover.sqlite'));
  cleanup.push(async () => recovered.close());
  for (const workspace of saved) {
    const state = recovered.workspace(workspace.id)!;
    expect(state.recoveryError).toContain(`Interrupted workspace ${state.operation}`);
    await expect(service.validate(repository, state)).rejects.toThrow('Interrupted');
    expect(await readFile(join(workspace.path, 'preserve.txt'), 'utf8')).toBe(state.operation);
  }
});

it('serializes concurrent write attempts and read-only registrations of an active task worktree', async () => {
  const env = await sandbox();
  const alias = await sandbox();
  cleanup.push(env.cleanup, alias.cleanup);
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
  const first = env.store.createTask({
    repositoryId: repo.id,
    title: 'First write',
    prompt: 'WAIT_FIXTURE',
    executionMode: 'write',
    agentId: 'codex-1',
  });
  const second = env.store.createTask({
    repositoryId: repo.id,
    title: 'Second write',
    prompt: 'Inspect',
    executionMode: 'write',
    agentId: 'codex-2',
  });
  manager.start(first.id, undefined, true);
  manager.start(second.id, undefined, true);
  await until(
    () => env.store.session(env.store.task(first.id)?.sessionId ?? '')?.threadId,
    Boolean,
  );
  const workspace = env.store.workspace(env.store.task(first.id)!.workspaceId!)!;
  expect(env.store.task(second.id)?.state).toBe('queued');
  const aliasRepo = alias.store.register(await validateRepository(workspace.path));
  const aliasTask = alias.store.createTask({
    repositoryId: aliasRepo.id,
    title: 'Alias read',
    prompt: 'WAIT_FIXTURE',
  });
  alias.manager.start(aliasTask.id);
  await until(
    () => alias.manager.dashboard().queue[0]?.waitingReason,
    (reason) => Boolean(reason?.includes('Worktree busy')),
  );
  expect(alias.store.task(aliasTask.id)?.state).toBe('queued');
  expect(alias.store.sessions()).toHaveLength(0);
  await alias.manager.stop(aliasTask.id);
  await manager.stop(first.id);
  await until(
    () => env.store.task(second.id)?.state,
    (state) => state === 'completed',
  );
  expect(env.store.task(second.id)?.workspaceId).not.toBe(workspace.id);
  expect(await git(env.repository, ['status', '--porcelain'])).toBe('');
  const readOnly = env.store.createTask({
    repositoryId: repo.id,
    title: 'Forbidden resume',
    prompt: 'Inspect',
  });
  expect(() => manager.start(readOnly.id, env.store.task(first.id)!.sessionId!)).toThrow(
    'same execution mode',
  );
});
it('rejects write resume after manual commits and requires inspection without resetting HEAD', async () => {
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
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Initial',
    prompt: 'Inspect',
    executionMode: 'write',
  });
  manager.start(task.id, undefined, true);
  await until(
    () => env.store.task(task.id)?.state,
    (state) => state === 'completed',
  );
  const workspace = env.store.workspace(env.store.task(task.id)!.workspaceId!)!;
  await writeFile(join(workspace.path, 'committed.txt'), 'preserve commit');
  commit(workspace.path);
  const head = await git(workspace.path, ['rev-parse', 'HEAD']);
  const resumed = env.store.createTask({
    repositoryId: repo.id,
    title: 'Resume',
    prompt: 'Inspect',
    executionMode: 'write',
  });
  manager.start(resumed.id, env.store.task(task.id)!.sessionId!, true);
  await until(
    () => env.store.task(resumed.id)?.state,
    (state) => state === 'failed',
  );
  expect(env.store.task(resumed.id)?.error).toContain('HEAD advanced');
  expect(await git(workspace.path, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await readFile(join(workspace.path, 'committed.txt'), 'utf8')).toBe('preserve commit');
});

it('journals a rejection whose final SQLite update fails after Git removes the worktree', async () => {
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
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Fault injection',
    prompt: 'Inspect',
    executionMode: 'write',
  });
  manager.start(task.id, undefined, true);
  await until(
    () => env.store.task(task.id)?.state,
    (state) => state === 'completed',
  );
  const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
  env.store.db.exec(
    `CREATE TRIGGER fail_rejected BEFORE UPDATE ON workspaces WHEN json_extract(NEW.json,'$.decision')='rejected' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END`,
  );
  await expect(
    manager.reviewOperation(task.id, 'reject', undefined, review.revision),
  ).rejects.toThrow('synthetic disk failure');
  await expect(lstat(review.workspace.path)).rejects.toThrow();
  expect(env.store.workspace(review.workspace.id)?.operation).toBe('rejecting');
  expect(
    ((await manager.reviewOperation(task.id, 'review')) as WorkspaceReview).workspace.recoveryError,
  ).toContain('operation failed');
  expect(await git(repo.path, ['rev-parse', `refs/heads/${review.workspace.branch}`])).toContain(
    review.workspace.base,
  );
});
it('rolls back workspace attachment if its task update cannot commit', async () => {
  const { root, repository } = await fixture();
  const store = new Store(join(root, 'atomic.sqlite'));
  cleanup.push(async () => store.close());
  const repo = store.register(repository);
  const task = store.createTask({ repositoryId: repo.id, title: 'Atomic', prompt: 'write' });
  store.db.exec(
    `CREATE TRIGGER fail_task BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'synthetic task failure'); END`,
  );
  const workspace = {
    id: randomUUID(),
    repositoryId: repo.id,
    path: '/unused',
    gitDir: '',
    branch: 'unused',
    base: 'unused',
    decision: 'pending' as const,
    operation: 'creating' as const,
  };
  expect(() => store.attachWorkspace(task.id, workspace)).toThrow('synthetic task failure');
  expect(store.workspace(workspace.id)).toBeUndefined();
  expect(store.task(task.id)?.workspaceId).toBeUndefined();
});

it('does not execute repository clean filters from AI-controlled attributes during review', async () => {
  const { service, repository, root } = await fixture();
  const workspace = await service.create(repository, randomUUID());
  const marker = join(root, 'filter-must-not-execute');
  const script = join(root, 'filter.cjs');
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'filter escaped agent sandbox');process.stdin.pipe(process.stdout);`,
  );
  await git(repository.path, ['config', 'filter.audit.clean', `'${process.execPath}' '${script}'`]);
  await writeFile(join(workspace.path, '.gitattributes'), '*.txt filter=audit\n');
  await writeFile(join(workspace.path, 'deleted.txt'), 'changed by agent\n');
  await service.review(repository, workspace);
  await expect(lstat(marker)).rejects.toThrow();
});

it.each(['replacement', 'commit'])(
  'revalidates workspace identity and HEAD after authentication (%s)',
  async (change) => {
    const env = await sandbox();
    cleanup.push(env.cleanup);
    commit(env.repository);
    const root = await realpath(env.root);
    const service = new Workspaces({
      authorizedRoot: root,
      workspaceRoot: join(root, 'worktrees'),
    });
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
    const original = env.provider.startSession.bind(env.provider);
    env.provider.startSession = async (path) => {
      const session = await original(path);
      const workspace = env.store.workspaces()[0]!;
      if (change === 'replacement') {
        await git(repo.path, ['worktree', 'remove', path]);
        await git(repo.path, ['worktree', 'add', path, workspace.branch]);
      }
      await writeFile(join(path, 'replacement.txt'), 'preserve post-auth replacement');
      if (change === 'commit') commit(path);
      return session;
    };
    const task = env.store.createTask({
      repositoryId: repo.id,
      title: 'Delayed auth',
      prompt: 'Inspect',
      executionMode: 'write',
    });
    manager.start(task.id, undefined, true);
    await until(
      () => env.store.task(task.id)?.state,
      (state) => state === 'failed',
    );
    expect(env.store.task(task.id)?.error).toContain(
      change === 'replacement' ? 'identity' : 'HEAD advanced',
    );
    expect(env.store.events(task.id).some((event) => event.kind === 'thread')).toBe(false);
    const workspace = env.store.workspaces()[0]!;
    expect(await readFile(join(workspace.path, 'replacement.txt'), 'utf8')).toBe(
      'preserve post-auth replacement',
    );
  },
);
it('keeps leases and reports interrupted rather than stopped when provider cleanup is uncertain', async () => {
  const env = await sandbox();
  cleanup.push(env.cleanup);
  commit(env.repository);
  const root = await realpath(env.root);
  const service = new Workspaces({ authorizedRoot: root, workspaceRoot: join(root, 'worktrees') });
  // No real worker is launched: the fixture deliberately reports unconfirmed cleanup.
  const provider: AgentProvider = {
    id: 'codex',
    capabilities: { cancellation: true, interactiveApprovals: false, writes: true },
    async startSession(repositoryPath) {
      return { id: randomUUID(), repositoryPath, threadId: null };
    },
    async resumeSession() {
      throw new Error('unused');
    },
    async executeTask() {},
    async *streamEvents() {
      yield { kind: 'result', text: 'fixture completed' };
    },
    async stopSession() {
      throw new Error('synthetic cleanup uncertainty');
    },
  };
  const manager = new TaskManager(env.store, provider, env.auth, undefined, undefined, service);
  cleanup.push(async () => {
    await expect(manager.shutdown()).rejects.toThrow('cleanup could not be confirmed');
  });
  const repo = env.store.register(await validateRepository(env.repository));
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Uncertain cleanup',
    prompt: 'Inspect',
    executionMode: 'write',
  });
  manager.start(task.id, undefined, true);
  await until(
    () => env.store.task(task.id)?.state,
    (state) => state === 'interrupted',
  );
  expect(env.store.task(task.id)?.error).toContain('lease retained');
  expect(manager.dashboard().agents[0]?.taskId).toBe(task.id);
  expect(manager.dashboard().agents[0]?.canStop).toBe(false);
  await expect(manager.stop(task.id)).rejects.toThrow('cleanup could not be confirmed');
  const unrelated = env.store.register({
    path: '/disposable/unstarted',
    gitDir: '/disposable/unstarted/.git',
    name: 'Unrelated',
  });
  const next = env.store.createTask({
    repositoryId: unrelated.id,
    title: 'Must remain queued',
    prompt: 'Inspect',
  });
  manager.start(next.id);
  expect(env.store.task(next.id)?.state).toBe('queued');
  expect(env.store.queue().some((entry) => entry.taskId === next.id)).toBe(true);
  await manager.stop(next.id);

  const workspace = env.store.workspaces()[0]!;
  const directories = await repositoryLeaseDirectories(repo, workspace.gitDir);
  for (const directory of directories) {
    const lock = join(
      '/tmp',
      `ai-office-worktrees-${process.getuid?.() ?? 'local'}`,
      createHash('sha256').update(directory).digest('hex'),
    );
    // This test created the lease and its provider has no process to orphan.
    cleanup.push(() => rm(lock, { recursive: true, force: true }));
    await expect(acquireLock(lock, 'must stay locked')).rejects.toThrow('locked');
  }
});

it('does not authorize writes to Git metadata outside the configured repository root', async () => {
  const { root, repository } = await fixture();
  const allowed = join(root, 'allowed');
  await mkdir(allowed);
  const linked = join(allowed, 'linked');
  await git(repository.path, ['worktree', 'add', '-b', 'audit-linked', linked]);
  const linkedRepo = {
    ...(await validateRepository(linked)),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const service = new Workspaces({
    authorizedRoot: allowed,
    workspaceRoot: join(root, 'agent-worktrees'),
  });
  await expect(service.create(linkedRepo, randomUUID())).rejects.toThrow('Git metadata is outside');
  expect(
    await git(repository.path, ['for-each-ref', '--format=%(refname)', 'refs/heads/ai-office/']),
  ).toBe('');
});
