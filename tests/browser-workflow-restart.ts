import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type APIResponse, type Page, type Route } from '@playwright/test';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { TaskManager } from '../src/server/manager.js';
import { profileConfiguration } from '../src/server/execution-config.js';
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
      const timeout = setTimeout(() => {
        cleanup();
        rejectReady(new Error('Backend startup timed out: ' + log.stderr));
      }, 20000);
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
    const exited = once(proc, 'exit', { signal: AbortSignal.timeout(10_000) });
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
    const originalCoder = store.agent('codex-1')!;
    // Use the same revisioned profile-edit path as the operator. Updating only
    // agent_versions would leave agent_profiles read-only and reject queue pinning.
    // No provider is authenticated, so this fixture never dispatches Codex.
    const coder = store.editAgent(originalCoder.id, originalCoder.revision, {
      ...originalCoder,
      maximumMode: 'write',
    });
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
    const stopped = stage('qa', 'stopped');
    store.updateTask(stopped.task.id, { state: 'stopped', error: 'QA stopped before restart.' });
    const blocked = stage('qa', 'completed');
    store.updateTask(blocked.task.id, { state: 'completed', result: 'Awaiting approval.' });
    // Unlike the downstream fixtures, this Coder is bound and queued through
    // the real atomic approval path. A write-capable task must never be replayed
    // after the process dies, even when it has not yet started.
    const coderWorkflow = workflows.create({
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
      ],
    });
    const coderApproval = workflows.transition(coderWorkflow.id, coderWorkflow.version, {
      type: 'approve',
      revision: baseline,
    });
    const queuedCoderTask = store.createTask({
      repositoryId: repository.id,
      agentId: coder.id,
      title: 'Approved Coder queued before restart',
      prompt: 'Write-capable fixture; never dispatch',
      executionMode: 'write',
    });
    const coderBinding = workflows.bindApprovedTask(
      coderWorkflow.id,
      coderApproval.version,
      queuedCoderTask.id,
    );
    const queuedCoder = workflows.enqueueApprovedTask(
      store,
      coderWorkflow.id,
      coderBinding.version,
      queuedCoderTask.id,
      'local-cli-chatgpt',
      baseline,
    );
    // A queued continuation is unrelated to the privileged workflow. Its
    // pinned session and private connection binding must survive both crashes.
    const sessionTask = store.createTask({
      repositoryId: repository.id,
      title: 'Queued session continuation',
      prompt: 'Unrelated persisted session',
    });
    const sessionBinding = {
      mode: 'local-cli-chatgpt' as const,
      contextId: 'private-browser-restart-context',
      model: null,
      runtimeVersion: '0.162.1',
    };
    const sessionConfiguration = profileConfiguration(store.agent('codex-1')!, sessionTask);
    const session = store.createSession(
      repository.id,
      sessionBinding,
      'codex',
      'codex-1',
      'read-only',
      undefined,
      sessionConfiguration,
    );
    store.setThread(session.id, 'browser-restart-thread');
    store.enqueue(sessionTask.id, 'local-cli-chatgpt', session.id);
    const ordinary = [sessionTask.id];
    for (const title of ['Ordinary first', 'Ordinary second']) {
      const task = store.createTask({
        repositoryId: repository.id,
        title,
        prompt: 'Unrelated queue item',
      });
      store.enqueue(task.id, 'local-cli-chatgpt');
      ordinary.push(task.id);
    }
    // Unsubmitted write task is intentionally outside the queue and every Workflow.
    // Its create action must be disabled when the dashboard snapshot goes stale.
    const unsubmittedCoder = store.createTask({
      repositoryId: repository.id,
      agentId: coder.id,
      title: 'Unsubmitted Coder creation gate',
      prompt: 'Never dispatch this synthetic task',
      executionMode: 'write',
    });
    store.close();

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(address);
    // The unified UI opens Office first. Enter Workflows without reloading
    // so the same mounted React page can observe each backend restart.
    const activePage: Page = page;
    const navigation = activePage.getByRole('navigation', { name: 'Dashboard sections' });
    const openScreen = async (name: 'Office' | 'Workflows', screen: 'office' | 'workflows') => {
      await navigation.getByRole('link', { name, exact: true }).click();
      await expect(activePage.locator('.shell')).toHaveAttribute('data-screen', screen);
    };
    await page.evaluate(() => {
      document.documentElement.dataset.restartPage = 'original';
    });
    await openScreen('Workflows', 'workflows');
    const board = page.getByRole('region', { name: 'Workflow timeline', exact: true });
    const selector = board.getByLabel('Workflow', { exact: true });
    await expect(selector.locator('option')).toHaveCount(5, { timeout: 15000 });
    await selector.selectOption(queuedCoder.id);
    await expect(board.getByText(/^State: active/)).toBeVisible();
    await expect(board).toContainText('CODER — running');
    await selector.selectOption(interrupted.workflowId);
    await expect(board.getByText(/^State: active/)).toBeVisible();
    await expect(board).toContainText('REVIEWER — running');
    const liveQueue = page.getByRole('region', { name: 'Submitted queue' });
    const inspectOfficeQueue = async (check: () => Promise<void>) => {
      await openScreen('Office', 'office');
      await expect(liveQueue).toBeVisible();
      try {
        await check();
      } finally {
        await openScreen('Workflows', 'workflows');
        await expect(board).toBeVisible();
      }
    };
    await inspectOfficeQueue(async () => {
      await expect(liveQueue).toContainText('Approved Coder queued before restart');
    });
    const assertOrdinaryQueueVisible = async () => {
      await inspectOfficeQueue(async () => {
        await expect(liveQueue.locator('li')).toHaveCount(3, { timeout: 20000 });
        for (const [index, title] of [
          'Queued session continuation',
          'Ordinary first',
          'Ordinary second',
        ].entries()) {
          await expect(liveQueue.locator('li').nth(index)).toContainText(title);
        }
        await expect(liveQueue).not.toContainText('Approved Coder queued before restart');
      });
    };

    // No reload: the same React page must observe a real process death and new backend.
    await kill();
    const restarted = await start(port);
    assert.equal(restarted, address);
    assert.equal(await page.locator('html').getAttribute('data-restart-page'), 'original');
    await expect(board.getByText(/^State: blocked/)).toBeVisible({ timeout: 20000 });
    await expect(board).toContainText('REVIEWER — interrupted');
    await assertOrdinaryQueueVisible();
    await expect(board.getByLabel('Workflow diagnostics')).toContainText(
      'Persisted checkpoint diagnostics',
    );
    await expect(board.getByRole('button', { name: 'Start Reviewer' })).toHaveCount(0);
    await selector.selectOption(failed.workflowId);
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board).toContainText('QA — failed');
    await selector.selectOption(stopped.workflowId);
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board).toContainText('QA — failed');
    await selector.selectOption(blocked.workflowId);
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board).toContainText('QA — blocked');
    await expect(board.getByRole('button', { name: 'Start QA' })).toHaveCount(0);
    await selector.selectOption(queuedCoder.id);
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board).toContainText('CODER — interrupted');
    await expect(board.getByRole('button', { name: 'Start Coder' })).toHaveCount(0);
    await selector.selectOption(blocked.workflowId);

    const dashboardResponse = await page.request.get(address + '/api/dashboard');
    assert.equal(dashboardResponse.status(), 200);
    const dashboard = await dashboardResponse.json();
    assert.deepEqual(
      dashboard.queue.map((item: { taskId: string }) => item.taskId),
      ordinary,
    );
    assert.equal(dashboard.queue[0]?.resumeSessionId, session.id);
    const recoveredSession = dashboard.sessions.find(
      (item: { id: string }) => item.id === session.id,
    );
    assert.equal(recoveredSession?.threadId, 'browser-restart-thread');
    assert.deepEqual(recoveredSession?.configuration, sessionConfiguration);
    assert.equal(JSON.stringify(dashboard).includes(sessionBinding.contextId), false);
    const taskStates = new Map(
      dashboard.tasks.map((task: { id: string; state: string }) => [task.id, task.state]),
    );
    assert.equal(taskStates.get(queuedCoderTask.id), 'interrupted');
    assert.equal(taskStates.get(interrupted.task.id), 'interrupted');
    assert.equal(taskStates.get(failed.task.id), 'failed');
    assert.equal(taskStates.get(stopped.task.id), 'stopped');
    assert.equal(taskStates.get(blocked.task.id), 'completed');
    const ids = [
      interrupted.workflowId,
      failed.workflowId,
      stopped.workflowId,
      blocked.workflowId,
      queuedCoder.id,
    ];
    const versions = await Promise.all(
      ids.map(async (id) => {
        const url = address + '/api/workflows/' + id;
        const response: APIResponse = await activePage.request.get(url);
        assert.equal(response.status(), 200);
        return (await response.json()).version as number;
      }),
    );
    // UI buttons are not an authorization boundary. Reuse current versions
    // against real HTTP mutation routes after recovery, not stale versions.
    // A blocked Workflow must reject forged approvals and preparations.
    const assertWorkflowMutationsRejected = async (id: string, version: number) => {
      const base = address + '/api/workflows/' + id;
      const mutations = [
        { action: 'approve-initial', data: { version, confirmed: true } },
        { action: 'bind-task', data: { version, confirmed: true, taskId: sessionTask.id } },
        { action: 'submit-initial', data: { version, confirmed: true, confirmedWrite: true } },
        { action: 'capture-coder-evidence', data: { version, confirmed: true } },
        {
          action: 'approve-coder-evidence',
          data: { version, confirmed: true, revision: 'c'.repeat(64) },
        },
        {
          action: 'approve-reviewer',
          data: { version, confirmed: true, revision: 'c'.repeat(64) },
        },
        { action: 'prepare-reviewer', data: { version, confirmed: true } },
      ];
      for (const mutation of mutations) {
        const response = await activePage.request.post(base + '/' + mutation.action, {
          data: mutation.data,
        });
        assert.equal(response.status(), 409, mutation.action + ' bypassed a terminal Workflow');
      }
      const unchanged = await activePage.request.get(base);
      assert.equal(unchanged.status(), 200);
      assert.equal((await unchanged.json()).version, version);
    };
    const assertBlockedMutations = async () => {
      for (const [index, id] of ids.entries()) {
        await assertWorkflowMutationsRejected(id, versions[index]!);
      }
    };
    const assertNoUnexpectedWorkflowAlerts = async () => {
      // The manual-review notice may render asynchronously after reconnect.
      // Its presence is safe; transport or other unexpected errors are not.
      const alerts = await board.getByRole('alert').allTextContents();
      for (const alert of alerts) {
        assert.equal(
          alert.trim(),
          'Workflow execution requires manual review after server restart.',
          'Unexpected Workflow alert after successful timeline reconnect',
        );
      }
    };
    await assertBlockedMutations();
    await page.screenshot({
      path: join(artifacts, 'workflow-process-recovered.png'),
      fullPage: true,
    });

    await kill();
    // A previously rendered blocked state is not evidence of reconnect.
    // Observe a fresh successful browser-originated API response after process death.
    const reconnected = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url() === address + '/api/workflows/' + blocked.workflowId + '/timeline' &&
        response.ok(),
      { timeout: 20000 },
    );
    await start(port);
    await reconnected;
    assert.equal(await page.locator('html').getAttribute('data-restart-page'), 'original');
    await expect(board.getByText(/^State: blocked/)).toBeVisible({ timeout: 20000 });
    await expect(board).toContainText('QA — blocked');
    await expect(board.getByRole('button', { name: 'Start QA' })).toHaveCount(0);
    await assertNoUnexpectedWorkflowAlerts();
    await board.getByText('Create workflow', { exact: true }).click();
    const coderChoice = board.getByRole('combobox', { name: 'Coder task', exact: true });
    await expect(coderChoice).toBeVisible();
    await expect(coderChoice.locator(`option[value="${unsubmittedCoder.id}"]`)).toHaveCount(1);
    await coderChoice.selectOption(unsubmittedCoder.id);
    const reviewerChoice = board.getByRole('combobox', {
      name: 'Reviewer profile',
      exact: true,
    });
    await expect(reviewerChoice).toBeVisible();
    await reviewerChoice.selectOption(reviewer.id);
    const createWorkflow = board.getByRole('button', { name: 'Create gated workflow' });
    await expect(createWorkflow).toBeEnabled();

    // Paused polling must not leave privileged controls actionable on a stale
    // snapshot. Resuming must first fetch a fresh successful checkpoint.
    await board.getByRole('button', { name: 'Pause live updates' }).click();
    await expect(
      board.getByText('Live updates are paused. Resume and refresh before changing workflows.'),
    ).toBeVisible();
    await expect(createWorkflow).toBeDisabled();
    await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeDisabled();
    await board.getByRole('button', { name: 'Resume live updates' }).click();
    await expect(createWorkflow).toBeEnabled({ timeout: 20000 });
    await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeEnabled();
    await assertNoUnexpectedWorkflowAlerts();

    // Exercise an actual browser-visible transport failure after a successful
    // reconnect. Persisted state may remain visible, but stale operator actions
    // must not be executable until the next successful timeline refresh.
    const timelineUrl = address + '/api/workflows/' + blocked.workflowId + '/timeline';
    await page.route(timelineUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic timeline outage' }),
      }),
    );
    const transportAlert = board.getByRole('alert').filter({
      hasText: 'Synthetic timeline outage',
    });
    await expect(transportAlert).toBeVisible({ timeout: 20000 });
    await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeDisabled();
    await expect(createWorkflow).toBeDisabled();
    await expect(board.getByText(/^State: blocked/)).toBeVisible();
    await expect(board.getByRole('button', { name: 'Start QA' })).toHaveCount(0);
    await page.unrouteAll({ behavior: 'wait' });
    await expect(transportAlert).toHaveCount(0, { timeout: 20000 });
    await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeEnabled();
    await expect(createWorkflow).toBeEnabled();
    await assertNoUnexpectedWorkflowAlerts();

    // A failed Dashboard fetch also leaves the creation form backed by stale
    // task/profile choices. It must fail closed until a fresh snapshot arrives.
    const dashboardUrl = address + '/api/dashboard';
    await page.route(dashboardUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic dashboard outage' }),
      }),
    );
    const dashboardAlert = board.getByRole('alert').filter({
      hasText: 'Synthetic dashboard outage',
    });
    await expect(dashboardAlert).toBeVisible({ timeout: 20000 });
    await expect(createWorkflow).toBeDisabled();
    await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeDisabled();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(dashboardAlert).toHaveCount(0, { timeout: 20000 });
    await expect(createWorkflow).toBeEnabled();
    await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeEnabled();
    await assertNoUnexpectedWorkflowAlerts();

    // A slow response from a previously selected Workflow must not replace a
    // newer checkpoint or turn a healthy board into an error state.
    const holdTimelineFailure = async (url: string, message: string) => {
      let release!: () => void;
      let held = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handler = async (route: Route) => {
        if (held) {
          await route.continue();
          return;
        }
        held = true;
        await gate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: message }),
        });
      };
      await activePage.route(url, handler);
      await expect.poll(() => held, { timeout: 20000 }).toBe(true);
      return { release, handler };
    };

    const staleSelectionMessage = 'Synthetic stale selection response';
    const delayedSelection = await holdTimelineFailure(timelineUrl, staleSelectionMessage);
    try {
      await selector.selectOption(failed.workflowId);
      await expect(board).toContainText('QA — failed');
      const staleResponse = activePage.waitForResponse(
        (response) => response.url() === timelineUrl && response.status() === 503,
        { timeout: 20000 },
      );
      delayedSelection.release();
      await staleResponse;
      await expect(selector).toHaveValue(failed.workflowId);
      await expect(board).toContainText('QA — failed');
      await expect(board.getByRole('alert').filter({ hasText: staleSelectionMessage })).toHaveCount(
        0,
      );
    } finally {
      delayedSelection.release();
      await activePage.unroute(timelineUrl, delayedSelection.handler);
    }
    await selector.selectOption(blocked.workflowId);
    await expect(board).toContainText('QA — blocked');
    await expect(createWorkflow).toBeEnabled();

    // Pausing discards an in-flight poll, and resuming must obtain a new
    // successful checkpoint. A late 503 from before the pause cannot revoke
    // the newly refreshed operator controls.
    const stalePauseMessage = 'Synthetic stale paused response';
    const delayedPause = await holdTimelineFailure(timelineUrl, stalePauseMessage);
    try {
      await board.getByRole('button', { name: 'Pause live updates' }).click();
      await expect(createWorkflow).toBeDisabled();
      const freshResponse = activePage.waitForResponse(
        (response) => response.url() === timelineUrl && response.status() === 200,
        { timeout: 20000 },
      );
      await board.getByRole('button', { name: 'Resume live updates' }).click();
      await freshResponse;
      await expect(createWorkflow).toBeEnabled();
      const staleResponse = activePage.waitForResponse(
        (response) => response.url() === timelineUrl && response.status() === 503,
        { timeout: 20000 },
      );
      delayedPause.release();
      await staleResponse;
      await expect(board.getByRole('alert').filter({ hasText: stalePauseMessage })).toHaveCount(0);
      await expect(createWorkflow).toBeEnabled();
      await expect(board.getByRole('button', { name: 'Cancel workflow' })).toBeEnabled();
    } finally {
      delayedPause.release();
      await activePage.unroute(timelineUrl, delayedPause.handler);
    }
    await assertNoUnexpectedWorkflowAlerts();

    // A fresh Dashboard can invalidate a form selection while the old ID
    // remains in React state. Do not allow submission of an absent Coder task.
    await page.route(dashboardUrl, async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          tasks: snapshot.tasks.filter((task: { id: string }) => task.id !== unsubmittedCoder.id),
        },
      });
    });
    await expect(coderChoice.locator(`option[value="${unsubmittedCoder.id}"]`)).toHaveCount(0, {
      timeout: 20000,
    });
    await expect(createWorkflow).toBeDisabled();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(coderChoice.locator(`option[value="${unsubmittedCoder.id}"]`)).toHaveCount(1, {
      timeout: 20000,
    });
    await expect(createWorkflow).toBeEnabled();

    // The same fail-closed rule applies to a selected Reviewer profile that
    // becomes archived or otherwise disappears from eligible profiles.
    await page.route(dashboardUrl, async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          profiles: snapshot.profiles.filter(
            (profile: { id: string }) => profile.id !== reviewer.id,
          ),
        },
      });
    });
    await expect(reviewerChoice.locator(`option[value="${reviewer.id}"]`)).toHaveCount(0, {
      timeout: 20000,
    });
    await expect(createWorkflow).toBeDisabled();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(reviewerChoice.locator(`option[value="${reviewer.id}"]`)).toHaveCount(1, {
      timeout: 20000,
    });
    await expect(createWorkflow).toBeEnabled();
    await assertNoUnexpectedWorkflowAlerts();
    await assertOrdinaryQueueVisible();
    for (const [index, id] of ids.entries()) {
      const response: APIResponse = await activePage.request.get(address + '/api/workflows/' + id);
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).version, versions[index]);
      const timeline = await activePage.request.get(address + '/api/workflows/' + id + '/timeline');
      assert.equal(timeline.status(), 200);
      const view = await timeline.json();
      assert.equal(view.state, 'blocked');
      assert.equal(view.downstreamExecutable, false);
    }
    await assertBlockedMutations();
    const after = await activePage.request.get(address + '/api/dashboard');
    assert.equal(after.status(), 200);
    const afterDashboard = await after.json();
    assert.deepEqual(
      afterDashboard.queue.map((item: { taskId: string }) => item.taskId),
      ordinary,
    );
    assert.equal(afterDashboard.queue[0]?.resumeSessionId, session.id);
    const afterSession = afterDashboard.sessions.find(
      (item: { id: string }) => item.id === session.id,
    );
    assert.equal(afterSession?.threadId, 'browser-restart-thread');
    assert.deepEqual(afterSession?.configuration, sessionConfiguration);
    assert.equal(JSON.stringify(afterDashboard).includes(sessionBinding.contextId), false);
    const afterTasks = new Map(
      afterDashboard.tasks.map((task: { id: string; state: string }) => [task.id, task.state]),
    );
    assert.equal(afterTasks.get(queuedCoderTask.id), 'interrupted');
    assert.equal(afterTasks.get(interrupted.task.id), 'interrupted');
    assert.equal(afterTasks.get(failed.task.id), 'failed');
    assert.equal(afterTasks.get(stopped.task.id), 'stopped');
    assert.equal(afterTasks.get(blocked.task.id), 'completed');

    // Recovery must leave a safe, explicit operator exit path. Cancelling a
    // blocked Workflow is allowed; replaying its stages is not. The terminal
    // cancellation must remain durable through another real process death.
    const cancelUrl = address + '/api/workflows/' + interrupted.workflowId + '/cancel';
    const cancellation = await activePage.request.post(cancelUrl, {
      data: { version: versions[0], confirmed: true },
    });
    assert.equal(cancellation.status(), 200);
    const cancelled = await cancellation.json();
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.version, versions[0]! + 1);
    const repeatedCancellation = await activePage.request.post(cancelUrl, {
      data: { version: cancelled.version, confirmed: true },
    });
    assert.equal(repeatedCancellation.status(), 409);
    await selector.selectOption(interrupted.workflowId);
    await expect(board.getByText(/^State: cancelled/)).toBeVisible();
    await expect(board).toContainText('REVIEWER — interrupted');
    await expect(board.getByRole('button', { name: 'Start Reviewer' })).toHaveCount(0);

    await kill();
    const terminalReconnect = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url() === address + '/api/workflows/' + interrupted.workflowId + '/timeline' &&
        response.ok(),
      { timeout: 20000 },
    );
    await start(port);
    await terminalReconnect;
    assert.equal(await page.locator('html').getAttribute('data-restart-page'), 'original');
    await expect(selector).toHaveValue(interrupted.workflowId);
    await expect(board.getByText(/^State: cancelled/)).toBeVisible({ timeout: 20000 });
    await expect(board.getByRole('button', { name: 'Start Reviewer' })).toHaveCount(0);
    await assertNoUnexpectedWorkflowAlerts();
    await assertOrdinaryQueueVisible();

    for (const [index, id] of ids.entries()) {
      const response = await activePage.request.get(address + '/api/workflows/' + id);
      assert.equal(response.status(), 200);
      const workflow = await response.json();
      assert.equal(workflow.version, index === 0 ? cancelled.version : versions[index]);
      assert.equal(workflow.state, index === 0 ? 'cancelled' : 'blocked');
    }
    const cancelledTimeline = await activePage.request.get(
      address + '/api/workflows/' + interrupted.workflowId + '/timeline',
    );
    assert.equal(cancelledTimeline.status(), 200);
    const terminalView = await cancelledTimeline.json();
    assert.equal(terminalView.state, 'cancelled');
    assert.equal(terminalView.downstreamExecutable, false);
    // Use the *current* cancelled version, not a stale pre-cancellation token.
    // All mutation routes must reject the terminal state itself.
    await assertWorkflowMutationsRejected(interrupted.workflowId, cancelled.version);
    const coderTimeline = await activePage.request.get(
      address + '/api/workflows/' + queuedCoder.id + '/timeline',
    );
    assert.equal(coderTimeline.status(), 200);
    const coderView = await coderTimeline.json();
    assert.equal(coderView.state, 'blocked');
    assert.equal(coderView.stages[0].status, 'interrupted');
    assert.equal(coderView.downstreamExecutable, false);

    const terminalDashboardResponse = await activePage.request.get(address + '/api/dashboard');
    assert.equal(terminalDashboardResponse.status(), 200);
    const terminalDashboard = await terminalDashboardResponse.json();
    assert.deepEqual(
      terminalDashboard.queue.map((item: { taskId: string }) => item.taskId),
      ordinary,
    );
    assert.equal(terminalDashboard.queue[0]?.resumeSessionId, session.id);
    const terminalSession = terminalDashboard.sessions.find(
      (item: { id: string }) => item.id === session.id,
    );
    assert.equal(terminalSession?.threadId, 'browser-restart-thread');
    assert.deepEqual(terminalSession?.configuration, sessionConfiguration);
    assert.equal(JSON.stringify(terminalDashboard).includes(sessionBinding.contextId), false);
    const terminalTasks = new Map(
      terminalDashboard.tasks.map((task: { id: string; state: string }) => [task.id, task.state]),
    );
    assert.equal(terminalTasks.get(queuedCoderTask.id), 'interrupted');
    assert.equal(terminalTasks.get(interrupted.task.id), 'interrupted');
    assert.equal(terminalTasks.get(failed.task.id), 'failed');
    assert.equal(terminalTasks.get(stopped.task.id), 'stopped');
    assert.equal(terminalTasks.get(blocked.task.id), 'completed');
    assert.deepEqual(pageErrors, []);
    passed = true;
    console.log(
      'Browser process-restart E2E passed: live reconnect, durable states, FIFO, no replay.',
    );
  } catch (error) {
    const evidence = [
      'Failure: ' + String(error),
      'Browser page errors: ' + JSON.stringify(pageErrors),
      'Workflow alert text: ' +
        JSON.stringify(
          page
            ? await page
                .getByRole('region', { name: 'Workflow timeline', exact: true })
                .getByRole('alert')
                .allTextContents()
                .catch(() => [])
            : [],
        ),
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
