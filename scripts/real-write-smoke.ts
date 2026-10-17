/** Explicit opt-in: two CLI-authenticated model turns. Never included in normal CI. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexAuth, inspectLocal } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { Store } from '../src/server/store.js';
import { TaskManager } from '../src/server/manager.js';
import { Workspaces } from '../src/server/workspaces.js';
import { validateRepository } from '../src/server/repositories.js';
import type { WorkspaceReview } from '../src/shared/types.js';

process.umask(0o077);
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const git = (repository: string, ...argv: string[]) =>
  execFileSync('/usr/bin/git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', ...argv], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
const identity = async (path: string) => {
  const stat = await lstat(path, { bigint: true });
  assert(!stat.isSymbolicLink());
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};
if (args.length === 1 && args[0] === '--prepare') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-real-write-')));
  const repository = join(root, 'repository');
  await mkdir(repository);
  git(repository, 'init', '-q');
  await writeFile(join(repository, 'README.md'), 'Disposable fixture\n');
  git(repository, 'add', '.');
  git(
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Fixture',
  );
  await writeFile(
    join(root, 'fixture.json'),
    JSON.stringify({
      root,
      identity: await identity(root),
      head: git(repository, 'rev-parse', 'HEAD'),
    }),
  );
  console.log(`Prepared without model usage: ${root}`);
} else {
  if (!args.includes('--run') || !args.includes('--root') || !args.includes('--model'))
    throw new Error(
      'First use --prepare. After approval: --run --root <printed path> --model <approved model>. Two model turns; no retries.',
    );
  const root = resolve(option('--root')!);
  assert.equal(await realpath(root), root);
  assert.equal(await realpath(join(root, '..')), await realpath(tmpdir()));
  assert(root.split('/').at(-1)!.startsWith('ai-office-real-write-'));
  const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
  assert.equal(fixture.root, root);
  assert.equal(fixture.identity, await identity(root));
  const repository = join(root, 'repository');
  assert.equal(await realpath(repository), repository);
  const primaryUnchanged = async () => {
    assert.equal(git(repository, 'status', '--porcelain'), '');
    assert.equal(git(repository, 'rev-parse', 'HEAD'), fixture.head);
    assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'Disposable fixture\n');
  };
  await primaryUnchanged();
  const model = option('--model')!;
  if (!args.includes('--stage')) {
    // Exclusive claim prevents an accidental rerun from consuming additional model usage.
    await writeFile(join(root, 'run-claimed'), model, { flag: 'wx' });
    for (const stage of ['write', 'review', 'persisted'])
      execFileSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(import.meta.url), ...args, '--stage', stage],
        {
          stdio: 'inherit',
          timeout: 360_000,
        },
      );
    console.log(`Real write E2E passed. Evidence and kept worktree preserved: ${root}`);
  } else {
    assert.equal(await readFile(join(root, 'run-claimed'), 'utf8'), model);
    assert(['write', 'review', 'persisted'].includes(option('--stage')!));
    if (option('--stage') === 'write')
      await writeFile(join(root, 'write-started'), model, { flag: 'wx' });
    const store = new Store(join(root, 'metadata.sqlite'));
    const auth = new CodexAuth({
      dataDir: root,
      inspectLocal: async () => {
        const local = await inspectLocal();
        assert.equal(
          local.models.find((entry) => entry.isDefault)?.model,
          model,
          'Default model changed since approval.',
        );
        return local;
      },
    });
    const manager = new TaskManager(
      store,
      new CodexProvider({ home: join(root, 'worker'), auth }),
      auth,
      undefined,
      120_000,
      new Workspaces({
        authorizedRoot: root,
        workspaceRoot: join(root, 'worktrees'),
        allowHostVerification: true,
        commands: {
          fixture: [
            process.execPath,
            '-e',
            "const fs=require('node:fs');if(fs.readFileSync('hello.txt','utf8')!=='hello\\n')process.exit(1);console.log('Fixture verified')",
          ],
        },
        verificationTimeoutMs: 10_000,
      }),
    );
    try {
      const stage = option('--stage');
      if (stage === 'write') {
        await auth.refresh();
        assert.equal(auth.view().mode, 'local-cli-chatgpt');
        assert.equal(
          auth.view().status,
          'available',
          'Existing CLI authentication required; no API fallback.',
        );
        const repo = store.register(await validateRepository(repository));
        for (const title of ['Keep fixture', 'Reject fixture']) {
          const task = store.createTask({
            repositoryId: repo.id,
            executionMode: 'write',
            title,
            prompt:
              'Create hello.txt containing exactly hello followed by a newline in the current worktree. Do not commit. Finish immediately.',
          });
          assert.throws(() => manager.start(task.id), /Confirm isolated writes/);
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
          assert(review.files.some((file) => file.path === 'hello.txt'));
          assert.match(review.diff, /hello/);
          assert.equal(
            git(
              repository,
              'show-ref',
              '--verify',
              '--hash',
              `refs/heads/${review.workspace.branch}`,
            ),
            fixture.head,
          );
          await primaryUnchanged();
        }
      } else if (stage === 'review') {
        assert.equal(store.tasks().length, 2);
        for (const task of store.tasks()) {
          assert.equal(task.state, 'completed');
          assert(store.session(task.sessionId!)?.threadId);
          let review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
          assert.equal(review.workspace.decision, 'pending');
          assert.equal(await readFile(join(review.workspace.path, 'hello.txt'), 'utf8'), 'hello\n');
          if (task.title === 'Keep fixture') {
            await manager.reviewOperation(task.id, 'verify', 'fixture', review.revision);
            review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
            assert.equal(review.workspace.verification?.passed, true);
            await manager.reviewOperation(task.id, 'keep', undefined, review.revision);
          } else {
            await manager.reviewOperation(task.id, 'reject', undefined, review.revision);
            await assert.rejects(lstat(review.workspace.path), { code: 'ENOENT' });
            assert.equal(
              git(
                repository,
                'show-ref',
                '--verify',
                '--hash',
                `refs/heads/${review.workspace.branch}`,
              ),
              fixture.head,
            );
          }
        }
      } else {
        assert.equal(stage, 'persisted');
        const results = [];
        for (const task of store.tasks()) {
          const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
          assert.equal(
            review.workspace.decision,
            task.title === 'Keep fixture' ? 'kept' : 'rejected',
          );
          if (review.workspace.decision === 'kept') {
            assert.equal(
              await readFile(join(review.workspace.path, 'hello.txt'), 'utf8'),
              'hello\n',
            );
            assert.equal(review.workspace.verification?.passed, true);
          }
          const turns = store
            .events(task.id)
            .map((event) => (event.data as { data?: unknown })?.data)
            .filter((data) => (data as { type?: string })?.type === 'turn.completed');
          assert.equal(turns.length, 1, 'Expected one recorded SDK usage event per task.');
          results.push({
            task: task.title,
            state: task.state,
            session: store.session(task.sessionId!),
            workspace: review.workspace,
            files: review.files,
            turns,
          });
        }
        await writeFile(
          join(root, 'evidence.json'),
          JSON.stringify(
            {
              model,
              cli: '0.162.1',
              sdk: '0.162.1',
              primaryUnchanged: true,
              processRestarts: 2,
              results,
            },
            null,
            2,
          ),
        );
        console.log(JSON.stringify({ model, turns: results.flatMap((result) => result.turns) }));
      }
      await primaryUnchanged();
    } finally {
      await manager.shutdown();
      store.close();
    }
  }
}
