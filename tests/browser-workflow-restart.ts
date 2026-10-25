import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type APIResponse, type Page } from '@playwright/test';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexAuth } from '../src/server/providers/codex-auth.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { AGENT_IDS } from '../src/shared/types.js';

// The child is a real HTTP backend process serving the compiled production UI.
// Authentication is deliberately unavailable: no provider can dispatch or infer.
if (process.argv.includes('--restart-server')) {
  const db = process.env.AI_OFFICE_RESTART_DB;
  if (!db) throw new Error('Missing isolated restart fixture database.');
  const store = new Store(db);
  const auth = new CodexAuth({
    dataDir: process.env.AI_OFFICE_RESTART_ROOT!,
    inspectLocal: async () => ({
      account: 'none',
      executable: process.execPath,
      env: { PATH: '/usr/bin:/bin' },
      version: '0.162.1',
      models: [],
    }),
  });
  await auth.refresh();
  const providers = AGENT_IDS.map(
    (id) =>
      new CodexProvider({
        home: join(process.env.AI_OFFICE_RESTART_ROOT!, 'workers', id),
        auth,
      }),
  );
  const manager = new TaskManager(store, providers, auth);
  const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
  const app = await createApp(manager);
  const address = await app.listen({
    host: '127.0.0.1',
    port: Number(process.env.AI_OFFICE_RESTART_PORT ?? '0'),
  });
  process.send?.({ type: 'ready', address });
} else {
  if (process.platform === 'win32')
    throw new Error('Process restart fixture requires POSIX signals.');
  const root = await mkdtemp(join(tmpdir(), 'ai-office-browser-restart-'));
  const db = join(root, 'office.sqlite');
  const externalArtifacts = process.env.AI_OFFICE_BROWSER_ARTIFACTS;
  const artifacts =
    externalArtifacts ?? (await mkdtemp(join(tmpdir(), 'ai-office-browser-restart-evidence-')));
  await mkdir(artifacts, { recursive: true });
  let child: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  let passed = false;
  const pageErrors: string[] = [];
  const serverLogs: Array<{ attempt: number; stderr: string }> = [];

  const start = async (port = 0): Promise<string> => {
    const proc = fork(resolve('tests/browser-workflow-restart.ts'), ['--restart-server'], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        AI_OFFICE_RESTART_ROOT: root,
        AI_OFFICE_RESTART_DB: db,
        AI_OFFICE_RESTART_PORT: String(port),
      },
    });
    child = proc;
    const log = { attempt: serverLogs.length + 1, stderr: '' };
    serverLogs.push(log);
    proc.stderr?.on('data', (chunk: Buffer) => {
      log.stderr = (log.stderr + chunk.toString()).slice(-65536);
    });
    return await new Promise<string>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => {
          cleanup();
          rejectReady(new Error('Backend startup timed out: ' + log.stderr));
        },
        20000,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        proc.off('exit', exited);
        proc.off('message', received);
        proc.off('error', errored);
      };
      const exited = (code: number | null) => {
        cleanup();
        rejectReady(new Error('Backend exited (' + code + '): ' + log.stderr));
      };
      const received = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type !== 'ready' || !('address' in message)) return;
        cleanup();
        resolveReady(String(message.address));
      };
      const errored = (error: Error) => {
        cleanup();
        rejectReady(error);
      };
      proc.on('exit', exited);
      proc.on('message', received);
      proc.on('error', errored);
    });
  };
  const kill = async () => {
    const proc = child;
    child = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit');
    proc.kill('SIGKILL');
    await exited;
  };

  try {
    const address = await start();
    const port = Number(new URL(address).port);
    const store = new Store(db);
    const repository = store.register({
      path: join(root, 'disposable'),
      gitDir: join(root, 'disposable', '.git'),
      name: 'restart-fixture',
    });
    const coder = store.agent('codex-1')!;
    // This fixture pins a write-capable Coder profile but never starts Codex.
    store.db
      .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
      .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, coder.revision);
    const reviewer = store.agent('codex-2')!;
    const workflows = new WorkflowStore(store.db);
    const baseline = 'a'.repeat(40);
    const revision = 'b'.repeat(40);

    const stage = (kind: 'reviewer' | 'qa', label: string) => {
      const created = workflows.create({
        repositoryId: repository.id,
        baselineRevision: baseline,
        stages: [
          { kind: 'coder', agentId: coder.id, agentRevision: coder.revision, mode: 'write' },
          {
            kind: 'reviewer',
            agentId: reviewer.id,
            agentRevision: reviewer.revision,
            mode: 'read-only',
          },
          {
            kind: 'qa',
            agentId: reviewer.id,
            agentRevision: reviewer.revision,
            mode: 'read-only',
          },
        ],
      });
      const approved = workflows.transition(created.id, created.version, {
        type: 'approve',
        revision: baseline,
      });
      const coderRunning = workflows.transition(created.id, approved.version, {
        type: 'start',
        taskId: 'coder-' + label,
        revision: baseline,
      });
      const coderDone = workflows.transition(created.id, coderRunning.version, {
        type: 'finish',
        taskId: 'coder-' + label,
        revision,
        succeeded: true,
      });
      const reviewerApproved = workflows.transition(created.id, coderDone.version, {
        type: 'approve',
        revision,
      });
      if (kind === 'reviewer') {
        const task = store.createTask({
          repositoryId: repository.id,
          agentId: reviewer.id,
          title: 'Reviewer awaiting restart',
          prompt: 'Read-only fixture; never dispatch',
          executionMode: 'read-only',
        });
        const running = workflows.transition(created.id, reviewerApproved.version, {
          type: 'start',
          taskId: task.id,
          revision,
        });
        return { task, workflowId: running.id };
      }
      const reviewerRunning = workflows.transition(created.id, reviewerApproved.version, {
        type: 'start',
        taskId: 'reviewer-' + label,
        revision,
      });
      const reviewerDone = workflows.transition(created.id, reviewerRunning.version, {
        type: 'finish',
        taskId: 'reviewer-' + label,
        revision,
        succeeded: true,
      });
      const qaApproved = workflows.transition(created.id, reviewerDone.version, {
        type: 'approve',
        revision,
      });
      const task = store.createTask({
        repositoryId: repository.id,
        agentId: reviewer.id,
        title: 'QA ' + label,
        prompt: 'Read-only fixture; never dispatch',
        executionMode: 'read-only',
      });
      const running = workflows.transition(created.id, qaApproved.version, {
        type: 'start',
        taskId: task.id,
        revision,
      });
      return { task, workflowId: running.id };
    };

    const interrupted = stage('reviewer', 'queued');
    store.enqueue(interrupted.task.id, 'local-cli-chatgpt');
    const failed = stage('qa', 'failed');
    store.updateTask(failed.task.id, { state: 'failed', error: 'QA failed before restart.' });
    const blocked = stage('qa', 'completed');
    store.updateTask(blocked.task.id, { state: 'completed', result: 'Awaiting approval.' });
    const ordinary = ['Ordinary first', 'Ordinary second'].map((title) => {
      const task = store.createTask({
        repositoryId: repository.id,
        title,
        prompt: 'Unrelated queue item',
      });
      store.enqueue(task.id, 'local-cli-chatgpt');
      return task.id;
    });
    store.close();

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(address);
    const board = page.getByRole('region', { name: 'Workflow timeline', exact: true });
    const selector = board.getByLabel('Workflow', { exact: true });
    await expect(selector.locator('option')).toHaveCount(3, { timeout: 15000 });
    await selector.selectOption(interrupted.workflowId);
    await expect(board.getByText(/^State: active/)).toBeVisible();
    await expect(board).toContainText('REVIEWER — running');

    // No reload: the same React page must observe a real process death and new backend.
    await kill();
    const restarted = await start(port);
    assert.equal(restarted, address);
    await expect(board.getByText(/^State: blocked/)).toBeVisible({ timeout: 20000 });
    await expect(board).toContainText('REVIEWER — interrupted');
    await expect(board.getByLabel('Workflow diagnostics')).toContainText(
      'Persisted checkpoint diagnostics',
    );
    await expect(board.getByRole('button', { name: 'Start Reviewer' })).toHaveCount(0);
    await selector.selectOption(failed.workflowId);
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board).toContainText('QA — failed');
    await selector.selectOption(blocked.workflowId);
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board).toContainText('QA — blocked');
    await expect(board.getByRole('button', { name: 'Start QA' })).toHaveCount(0);

    const dashboardResponse = await page.request.get(address + '/api/dashboard');
    assert.equal(dashboardResponse.status(), 200);
    const dashboard = await dashboardResponse.json();
    assert.deepEqual(
      dashboard.queue.map((item: { taskId: string }) => item.taskId),
      ordinary,
    );
    const taskStates = new Map(
      dashboard.tasks.map((task: { id: string; state: string }) => [task.id, task.state]),
    );
    assert.equal(taskStates.get(interrupted.task.id), 'interrupted');
    assert.equal(taskStates.get(failed.task.id), 'failed');
    assert.equal(taskStates.get(blocked.task.id), 'completed');
    const ids = [interrupted.workflowId, failed.workflowId, blocked.workflowId];
    const activePage = page;
    const versions = await Promise.all(
      ids.map(async (id) => {
        const url = address + '/api/workflows/' + id;
        const response: APIResponse = await activePage.request.get(url);
        assert.equal(response.status(), 200);
        return (await response.json()).version as number;
      }),
    );
    await page.screenshot({
      path: join(artifacts, 'workflow-process-recovered.png'),
      fullPage: true,
    });

    await kill();
    // A previously rendered blocked state is not evidence of reconnect.
    // Observe a fresh successful browser-originated API response after process death.
    const reconnected = page.waitForResponse(
      (response) => response.url().startsWith(address + '/api/') && response.ok(),
      { timeout: 20000 },
    );
    await start(port);
    await reconnected;
    await expect(board.getByText(/^State: blocked/)).toBeVisible({ timeout: 20000 });
    for (const [index, id] of ids.entries()) {
      const response: APIResponse = await activePage.request.get(
        address + '/api/workflows/' + id,
      );
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).version, versions[index]);
    }
    const after = await activePage.request.get(address + '/api/dashboard');
    assert.equal(after.status(), 200);
    assert.deepEqual(
      (await after.json()).queue.map((item: { taskId: string }) => item.taskId),
      ordinary,
    );
    assert.deepEqual(pageErrors, []);
    passed = true;
    console.log(
      'Browser process-restart E2E passed: live reconnect, durable states, FIFO, no replay.',
    );
  } catch (error) {
    const evidence = [
      'Failure: ' + String(error),
      'Browser page errors: ' + JSON.stringify(pageErrors),
      'Backend stderr (bounded per attempt): ' + JSON.stringify(serverLogs, null, 2),
    ].join('\n\n');
    await Promise.allSettled([
      writeFile(join(artifacts, 'restart-failure.txt'), evidence),
      ...(page
        ? [
            page.screenshot({
              path: join(artifacts, 'workflow-restart-failure.png'),
              fullPage: true,
              timeout: 5000,
            }),
          ]
        : []),
    ]);
    console.error('Browser restart failure evidence:', artifacts);
    throw error;
  } finally {
    await browser?.close();
    await kill();
    await rm(root, { recursive: true, force: true });
    if (passed && !externalArtifacts) await rm(artifacts, { recursive: true, force: true });
  }
}
