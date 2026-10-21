/** Explicit opt-in. Two real local ChatGPT Codex turns in a new disposable repository. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { TaskManager } from '../src/server/manager.js';
import { Workspaces } from '../src/server/workspaces.js';
import { createApp } from '../src/server/app.js';
import { validateRepository } from '../src/server/repositories.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { nativeCodex } from '../src/server/providers/native-isolation.js';
import type { Workflow } from '../src/server/workflows.js';

if (!process.argv.includes('--run'))
  throw new Error(
    'Use --run to authorize two real model turns in a NEW disposable checkout. No retries, merge, release or deployment.',
  );
process.umask(0o077);
const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-real-workflow-')));
const repository = join(root, 'repository');
await mkdir(repository);
const git = (...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
git('init', '-q');
await writeFile(join(repository, 'README.md'), 'PLACEHOLDER\n');
git('add', '.');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'Disposable baseline',
);
const baseline = git('rev-parse', 'HEAD');
const store = new Store(join(root, 'metadata.sqlite'));
const auth = new CodexAuth({ dataDir: root, localExecutable: nativeCodex });
await auth.refresh();
assert.equal(auth.view().status, 'available', auth.view().message);
const execution = await auth.prepare();
const model = execution.binding.model;
assert.ok(model);
for (const profile of store.agents())
  store.editAgent(profile.id, profile.revision, {
    ...profile,
    model,
    maximumMode: profile.id === 'codex-1' ? 'write' : 'read-only',
  });
const providers = ['codex-1', 'codex-2'].map(
  (id) => new CodexProvider({ home: join(root, 'workers', id), auth }),
);
const workspaces = new Workspaces({
  authorizedRoot: root,
  workspaceRoot: join(root, 'worktrees'),
  allowHostVerification: false,
  commands: {
    content: [
      '/bin/sh',
      '-c',
      'test "$(cat README.md)" = "Hello from AI Office v0.7" && echo "Live QA assertions passed"',
    ],
  },
  verificationTimeoutMs: 5000,
});
const manager = new TaskManager(store, providers, auth, undefined, 180000, workspaces);
const app = await createApp(manager);
let workflowId = '';
let succeeded = false;
try {
  const registered = store.register(await validateRepository(repository));
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
    payload: {
      repositoryId: registered.id,
      coderAgentId: 'codex-1',
      reviewerAgentId: 'codex-2',
      qaAgentId: 'codex-2',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  workflowId = created.json().id;
  const current = () => new WorkflowStore(store.db).get(workflowId)!;
  const post = async (
    action: string,
    extra: Record<string, unknown> = {},
    expected = 200,
  ): Promise<Workflow> => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/${action}`,
      headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
      payload: { version: current().version, confirmed: true, ...extra },
    });
    assert.equal(response.statusCode, expected, response.body);
    return response.json().workflow ?? response.json();
  };
  const wait = async (taskId: string) => {
    const deadline = Date.now() + 200000;
    while (Date.now() < deadline) {
      const task = store.task(taskId)!;
      if (['completed', 'failed', 'interrupted', 'stopped'].includes(task.state)) {
        assert.equal(
          task.state,
          'completed',
          JSON.stringify({ state: task.state, error: task.error }),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Live workflow task did not finish within its bound.');
  };
  await post('approve-initial');
  const coder = store.createTask({
    repositoryId: registered.id,
    agentId: 'codex-1',
    executionMode: 'write',
    title: 'Live disposable workflow',
    prompt:
      'In README.md replace PLACEHOLDER with exactly Hello from AI Office v0.7, followed by a newline. Change no other file. Do not execute tests, commit, push or merge. This is a disposable validation repository.',
  });
  await post('bind-task', { taskId: coder.id });
  await post('submit-initial', { confirmedWrite: true }, 202);
  await wait(coder.id);
  console.log('Live Coder completed; validating evidence.');
  const captured = await post('capture-coder-evidence');
  const revision = captured.stages[0]!.evidence!.revision;
  const workspace = store.workspace(store.task(coder.id)!.workspaceId!)!;
  assert.equal(
    await readFile(join(workspace.path, 'README.md'), 'utf8'),
    'Hello from AI Office v0.7\n',
  );
  await post('approve-coder-evidence', { revision });
  await post('approve-reviewer', { revision });
  await post('prepare-reviewer');
  const submitted = await post('submit-reviewer', {}, 202);
  await wait(submitted.stages[1]!.taskId!);
  console.log('Live SDK Reviewer completed in verified native read-only sandbox.');
  await post('approve-reviewer-result', { digest: current().stages[1]!.report!.digest });
  await post('approve-qa', { revision, commandId: 'content' });
  const qa = await post('submit-qa', {}, 202);
  await wait(qa.stages[2]!.taskId!);
  await post('approve-qa-result', { digest: current().stages[2]!.report!.digest });
  assert.equal(current().state, 'completed');
  assert.equal(git('rev-parse', 'HEAD'), baseline);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'PLACEHOLDER\n');
  succeeded = true;
} finally {
  await app.close();
  const workflow = workflowId ? new WorkflowStore(store.db).get(workflowId) : undefined;
  const evidence = {
    root,
    model,
    succeeded,
    primaryUnchanged: git('rev-parse', 'HEAD') === baseline && git('status', '--porcelain') === '',
    workflow,
    tasks: store
      .tasks()
      .map((task) => ({ id: task.id, state: task.state, result: task.result, error: task.error })),
  };
  await writeFile(join(root, 'verification.json'), JSON.stringify(evidence, null, 2));
  store.close();
  console.log(
    JSON.stringify({
      root,
      model,
      succeeded,
      workflowId,
      evidence: join(root, 'verification.json'),
    }),
  );
}
