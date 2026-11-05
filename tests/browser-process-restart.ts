// A real separate-process backend restart while the production React page stays mounted.
// This uses deterministic DB/SDK fixtures; it does not call a model or run a workflow.
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { sandbox, removeTestTree } from './helpers.js';
import { WorkflowStore } from '../src/server/workflows.js';

const env = await sandbox();
// Commit the harmless disposable source so workflow revision attestation has
// an actual SHA; no AI-authored changes or external repository is involved.
execFileSync('/usr/bin/git', ['-C', env.repository, 'add', 'README.md']);
execFileSync('/usr/bin/git', [
  '-C',
  env.repository,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'fixture baseline',
]);
const baselineRevision = execFileSync(
  '/usr/bin/git',
  ['-C', env.repository, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' },
).trim();
const repoGitDir = execFileSync('/usr/bin/git', ['-C', env.repository, 'rev-parse', '--absolute-git-dir'], {
  encoding: 'utf8',
}).trim();
const repo = env.store.register({ name: 'Restart browser fixture', path: env.repository, gitDir: repoGitDir });
const interrupted = env.store.createTask({
  repositoryId: repo.id, agentId: 'codex-1', title: 'Crash-recovery task',
  prompt: 'Fixture only — must never be submitted', executionMode: 'read-only',
});
const pending = env.store.createTask({
  repositoryId: repo.id, agentId: 'codex-2', title: 'Unsubmitted task',
  prompt: 'Fixture only — must stay unsubmitted', executionMode: 'read-only',
});
// Persist a valid workflow skeleton through the real WorkflowStore. Simulated
// crash states are seeded below directly in SQLite, without running Codex.
const reviewerTask = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-2',
  title: 'Interrupted reviewer fixture',
  prompt: 'No inference',
  executionMode: 'read-only',
});
const queuedReviewerTask = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-2',
  title: 'Queued reviewer must not replay',
  prompt: 'No inference',
  executionMode: 'read-only',
});
const completedQaTask = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-2',
  title: 'Unapproved QA result fixture',
  prompt: 'No inference',
  executionMode: 'read-only',
});
const failedQaTask = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-2',
  title: 'Failed QA fixture',
  prompt: 'No inference',
  executionMode: 'read-only',
});
const fifoFirst = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-1',
  title: 'Independent FIFO first',
  prompt: 'Do not execute in this test',
  executionMode: 'read-only',
});
const fifoSecond = env.store.createTask({
  repositoryId: repo.id,
  agentId: 'codex-2',
  title: 'Independent FIFO second',
  prompt: 'Do not execute in this test',
  executionMode: 'read-only',
});
const workflowStore = new WorkflowStore(env.store.db);
const coderProfile = env.store.requireAgent('codex-1');
const reviewerProfile = env.store.requireAgent('codex-2');
const newWorkflow = () =>
  workflowStore.create({
    repositoryId: repo.id,
    baselineRevision,
    stages: [
      { kind: 'coder', agentId: coderProfile.id, agentRevision: coderProfile.revision, mode: 'write' },
      { kind: 'reviewer', agentId: reviewerProfile.id, agentRevision: reviewerProfile.revision, mode: 'read-only' },
      { kind: 'qa', agentId: reviewerProfile.id, agentRevision: reviewerProfile.revision, mode: 'read-only' },
    ],
  });
const reviewerWorkflow = newWorkflow();
const queuedReviewerWorkflow = newWorkflow();
const completedQaWorkflow = newWorkflow();
const pendingQaWorkflow = newWorkflow();
const failedQaWorkflow = newWorkflow();
const qaReportDigest = 'b'.repeat(64);
const buildWorkflowSeed = (id: string, kind: 'reviewer' | 'queued-reviewer' | 'completed-qa' | 'pending-qa' | 'failed-qa') => {
  const current = workflowStore.get(id);
  assert.ok(current);
  const next = structuredClone(current);
  next.stages[0]!.state = 'completed';
  if (kind === 'reviewer' || kind === 'queued-reviewer') {
    next.stages[1]!.state = 'running';
    next.stages[1]!.taskId = kind === 'reviewer' ? reviewerTask.id : queuedReviewerTask.id;
  } else {
    next.stages[1]!.state = 'completed';
    next.stages[2]!.state =
      kind === 'completed-qa' ? 'running' : kind === 'failed-qa' ? 'failed' : 'awaiting_approval';
    if (kind === 'failed-qa') {
      next.state = 'blocked';
      next.stages[2]!.taskId = failedQaTask.id;
    }
    if (kind === 'completed-qa') {
      next.stages[2]!.taskId = completedQaTask.id;
      next.stages[2]!.report = {
        taskId: completedQaTask.id,
        revision: baselineRevision,
        sourceDigest: 'a'.repeat(64),
        digest: qaReportDigest,
        completedAt: new Date().toISOString(),
      };
    }
  }
  return next;
};
const workflowSeeds = [
  buildWorkflowSeed(reviewerWorkflow.id, 'reviewer'),
  buildWorkflowSeed(queuedReviewerWorkflow.id, 'queued-reviewer'),
  buildWorkflowSeed(completedQaWorkflow.id, 'completed-qa'),
  buildWorkflowSeed(pendingQaWorkflow.id, 'pending-qa'),
  buildWorkflowSeed(failedQaWorkflow.id, 'failed-qa'),
];
await env.manager.shutdown();
env.store.close();

const temp = createServer();
await new Promise<void>((accept, reject) => {
  temp.once('error', reject);
  temp.listen(0, '127.0.0.1', () => accept());
});
const endpoint = temp.address();
assert.ok(endpoint && typeof endpoint !== 'string');
const port = endpoint.port;
await new Promise<void>((accept) => temp.close(() => accept()));

const fixtureScript = resolve('tests/fixtures/restart-browser-server.mjs');
let child: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const terminate = async (processToStop: ChildProcess | undefined) => {
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const exit = new Promise<void>((accept) => processToStop.once('exit', () => accept()));
  processToStop.kill('SIGKILL');
  await exit;
};
const start = async (): Promise<ChildProcess> => {
  const processToStart = fork(fixtureScript, [env.root, String(port)], {
    cwd: process.cwd(), execArgv: [], silent: true,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: env.root,
      AI_OFFICE_ALLOW_HOST_VERIFICATION: '0',
      AI_OFFICE_TEST_PAUSE_DISPATCH: '1',
    },
  });
  try {
    await new Promise<void>((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error('Backend fixture startup deadline')), 15000);
      let stderr = '';
      processToStart.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + String(chunk)).slice(-1500);
      });
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        processToStart.off('message', onMessage);
        processToStart.off('exit', onExit);
        if (error) reject(error);
        else accept();
      };
      const onMessage = (value: unknown) => {
        if ((value as { type?: string })?.type === 'ready') finish();
      };
      const onExit = () => finish(new Error('Backend exited before ready: ' + stderr));
      processToStart.on('message', onMessage);
      processToStart.once('exit', onExit);
    });
  } catch (error) {
    await terminate(processToStart);
    throw error;
  }
  return processToStart;
};

try {
  child = await start();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const address = 'http://127.0.0.1:' + port;
  await page.goto(address);
  const connection = page.locator('.connection');
  await expect(connection).toContainText(/^(Local server connected|Live events connected)$/, {
    timeout: 10000,
  });
  const originalDocument = await page.evaluate(() => {
    (window as Window & { __restartFixture?: string }).__restartFixture = 'preserved';
    return document.documentElement.tagName;
  });
  assert.ok(originalDocument);
  // Write synthetic unfinished state into the persistent DB while backend #1
  // is still alive. This simulates an unclean process exit with a running turn,
  // without creating a provider request or a runnable queue entry.
  const db = new DatabaseSync(join(env.root, 'metadata.sqlite'));
  try {
    const row = db.prepare('SELECT json FROM tasks WHERE id=?').get(interrupted.id);
    assert.ok(row);
    const task = JSON.parse(String(row.json));
    task.state = 'running';
    db.prepare('UPDATE tasks SET state=?, json=? WHERE id=?').run(
      'running',
      JSON.stringify(task),
      interrupted.id,
    );
    for (const [taskId, state] of [
      [reviewerTask.id, 'running'],
      [completedQaTask.id, 'completed'],
      [failedQaTask.id, 'failed'],
    ] as const) {
      const row = db.prepare('SELECT json FROM tasks WHERE id=?').get(taskId);
      assert.ok(row);
      const item = JSON.parse(String(row.json));
      item.state = state;
      db.prepare('UPDATE tasks SET state=?, json=? WHERE id=?').run(
        state,
        JSON.stringify(item),
        taskId,
      );
    }
    // Seed the simulated in-flight stages only immediately before the crash.
    // Seeding before backend #1 starts would trigger an earlier recovery pass.
    for (const workflow of workflowSeeds) {
      db.prepare('UPDATE workflows SET json=? WHERE id=?').run(
        JSON.stringify(workflow),
        workflow.id,
      );
    }
    // Model a previously approved stage whose runnable queue entry survived
    // a process crash. Store.recoverInterrupted must remove this *before*
    // the new manager starts its queue on listen.
    db.prepare(
      'INSERT INTO task_queue(task_id,resume_session_id,mode,enqueued_at) VALUES (?,?,?,?)',
    ).run(queuedReviewerTask.id, null, 'local-cli-chatgpt', new Date().toISOString());
    for (const taskId of [fifoFirst.id, fifoSecond.id]) {
      db.prepare(
        'INSERT INTO task_queue(task_id,resume_session_id,mode,enqueued_at) VALUES (?,?,?,?)',
      ).run(taskId, null, 'local-cli-chatgpt', new Date().toISOString());
    }
  } finally {
    db.close();
  }
  await terminate(child);
  child = undefined;
  await expect(connection).toContainText('Server disconnected', { timeout: 12000 });
  child = await start();
  await expect(connection).toContainText(/^(Local server connected|Live events connected)$/, {
    timeout: 12000,
  });
  await expect
    .poll(async () => page.evaluate(() => (window as Window & { __restartFixture?: string }).__restartFixture))
    .toBe('preserved');
  await expect
    .poll(async () => {
      const res = await page.request.get(address + '/api/dashboard');
      const result = await res.json();
      return result.tasks.find((task: { id: string }) => task.id === interrupted.id)?.state;
    })
    .toBe('interrupted');
  const response = await page.request.get(address + '/api/dashboard');
  const snapshot = await response.json();
  assert.equal(snapshot.tasks.find((t: { id: string }) => t.id === pending.id)?.state, 'queued');
  assert.deepEqual(
    snapshot.queue.map((entry: { taskId: string }) => entry.taskId),
    [fifoFirst.id, fifoSecond.id],
    'Unrelated submitted work must retain FIFO order after recovery',
  );
  assert.equal(
    snapshot.queue.some((entry: { taskId: string }) => entry.taskId === queuedReviewerTask.id),
    false,
    'A queued privileged Reviewer stage must be quarantined before dispatch',
  );
  const workflowResponse = await page.request.get(address + '/api/workflows');
  assert.equal(workflowResponse.status(), 200);
  const workflowItems = await workflowResponse.json();
  const workflowById = new Map(workflowItems.map((item: { id: string }) => [item.id, item]));
  for (const workflowId of [
    reviewerWorkflow.id,
    queuedReviewerWorkflow.id,
    completedQaWorkflow.id,
    failedQaWorkflow.id,
  ]) {
    assert.equal(
      (workflowById.get(workflowId) as { state?: string } | undefined)?.state,
      'blocked',
      'Interrupted or unapproved workflow must remain blocked after restart',
    );
  }
  assert.equal(
    (workflowById.get(pendingQaWorkflow.id) as { state?: string } | undefined)?.state,
    'active',
    'Pending QA approval must not be silently granted',
  );
  const readWorkflow = async (id: string) => {
    const response = await page.request.get(address + '/api/workflows/' + id);
    assert.equal(response.status(), 200);
    return response.json();
  };
  const reviewerRecovered = await readWorkflow(reviewerWorkflow.id);
  const queuedReviewerRecovered = await readWorkflow(queuedReviewerWorkflow.id);
  const qaRecovered = await readWorkflow(completedQaWorkflow.id);
  const pendingRecovered = await readWorkflow(pendingQaWorkflow.id);
  const failedQaRecovered = await readWorkflow(failedQaWorkflow.id);
  assert.equal(reviewerRecovered.stages[1].state, 'interrupted');
  assert.equal(queuedReviewerRecovered.stages[1].state, 'interrupted');
  assert.equal(
    snapshot.tasks.find((t: { id: string }) => t.id === queuedReviewerTask.id)?.state,
    'interrupted',
    'Recovery must quarantine a queued reviewer task',
  );
  assert.equal(qaRecovered.stages[2].state, 'blocked');
  assert.equal(qaRecovered.stages[2].report.digest, qaReportDigest);
  const qaResultsResponse = await page.request.get(
    address + '/api/workflows/' + completedQaWorkflow.id + '/results',
  );
  assert.equal(qaResultsResponse.status(), 200);
  const qaResults = await qaResultsResponse.json();
  assert.equal(qaResults[1].report.digest, qaReportDigest, 'QA report must survive crash');
  assert.equal(pendingRecovered.stages[2].state, 'awaiting_approval');
  assert.equal(failedQaRecovered.stages[2].state, 'failed');
  assert.equal(failedQaRecovered.state, 'blocked');
  assert.equal(snapshot.tasks.find((t: { id: string }) => t.id === reviewerTask.id)?.state, 'interrupted');
  assert.equal(snapshot.tasks.find((t: { id: string }) => t.id === completedQaTask.id)?.state, 'completed');
  // Assert the mounted UI caught up, not just that a separate API request succeeded.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await expect(
    page.locator('.task-row').filter({ hasText: 'Crash-recovery task' }).locator('.badge'),
  ).toHaveText('interrupted', { timeout: 12000 });
  await expect(
    page.locator('.task-row').filter({ hasText: 'Unsubmitted task' }).locator('.badge'),
  ).toHaveText('queued');
  // A second restart must not replay workflow recovery or increment versions.
  // The same page stays open throughout both process generations.
  const initialVersions = new Map(
    [reviewerRecovered, queuedReviewerRecovered, qaRecovered, pendingRecovered, failedQaRecovered].map((item: { id: string; version: number }) => [
      item.id,
      item.version,
    ]),
  );
  await terminate(child);
  child = undefined;
  await expect(connection).toContainText('Server disconnected', { timeout: 12000 });
  child = await start();
  await expect(connection).toContainText(/^(Local server connected|Live events connected)$/, {
    timeout: 12000,
  });
  for (const id of [
    reviewerWorkflow.id,
    queuedReviewerWorkflow.id,
    completedQaWorkflow.id,
    pendingQaWorkflow.id,
    failedQaWorkflow.id,
  ]) {
    const current = await readWorkflow(id);
    assert.equal(current.version, initialVersions.get(id), 'Restart must not churn workflow versions');
  }
  const secondQaResultsResponse = await page.request.get(
    address + '/api/workflows/' + completedQaWorkflow.id + '/results',
  );
  assert.equal(secondQaResultsResponse.status(), 200);
  assert.deepEqual(await secondQaResultsResponse.json(), qaResults);
  const secondResponse = await page.request.get(address + '/api/dashboard');
  const secondSnapshot = await secondResponse.json();
  assert.deepEqual(
    secondSnapshot.queue.map((entry: { taskId: string }) => entry.taskId),
    [fifoFirst.id, fifoSecond.id],
    'Repeated recovery must not reorder unrelated queued jobs',
  );
  assert.equal(
    secondSnapshot.tasks.find((task: { id: string }) => task.id === reviewerTask.id)?.state,
    'interrupted',
  );
  assert.equal(
    await page.evaluate(() => (window as Window & { __restartFixture?: string }).__restartFixture),
    'preserved',
    'Dashboard must not reload during repeated recovery',
  );
  assert.equal(errors.length, 0, 'Unexpected browser errors: ' + errors.join(' | '));
} finally {
  await terminate(child);
  await browser?.close();
  await removeTestTree(env.root);
}
