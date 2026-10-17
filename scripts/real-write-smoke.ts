/** Explicit opt-in; consumes existing CLI-authenticated Codex usage, never runs in CI. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { Workspaces } from '../src/server/workspaces.js';
import { validateRepository } from '../src/server/repositories.js';
import type { WorkspaceReview } from '../src/shared/types.js';
if (!process.argv.includes('--run'))
  throw new Error('Pass --run to consume existing CLI-authenticated Codex usage.');
process.umask(0o077);
const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-real-write-')));
const repository = join(root, 'repository');
await mkdir(repository);
execFileSync('/usr/bin/git', ['init', '-q', repository]);
await writeFile(join(repository, 'README.md'), 'Disposable fixture\n');
execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
execFileSync('/usr/bin/git', [
  '-C',
  repository,
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
const store = new Store(join(root, 'metadata.sqlite'));
const auth = new CodexAuth({ dataDir: root });
await auth.refresh();
assert.equal(auth.view().mode, 'local-cli-chatgpt');
assert.equal(
  auth.view().status,
  'available',
  'Existing CLI authentication required; no API fallback.',
);
const provider = new CodexProvider({ home: join(root, 'worker'), auth });
const manager = new TaskManager(
  store,
  provider,
  auth,
  undefined,
  120_000,
  new Workspaces({ authorizedRoot: root, workspaceRoot: join(root, 'worktrees') }),
);
try {
  const repo = store.register(await validateRepository(repository));
  const task = store.createTask({
    repositoryId: repo.id,
    executionMode: 'write',
    title: 'Real write smoke',
    prompt:
      'Create hello.txt containing exactly hello followed by a newline in the current worktree. Do not commit. Finish immediately.',
  });
  manager.start(task.id, undefined, true);
  while (['queued', 'running', 'stopping'].includes(store.task(task.id)!.state))
    await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    store.task(task.id)!.state,
    'completed',
    store.task(task.id)!.error ?? 'Task failed',
  );
  const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
  assert.equal(await readFile(join(review.workspace.path, 'hello.txt'), 'utf8'), 'hello\n');
  await assert.rejects(readFile(join(repository, 'hello.txt')));
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'Disposable fixture\n');
  await manager.reviewOperation(task.id, 'reject');
  console.log(
    'Real CLI-authenticated write smoke passed: isolated file, Git review, rejection, primary checkout unchanged.',
  );
} finally {
  await manager.shutdown();
  store.close();
  await rm(root, { recursive: true, force: true });
}
