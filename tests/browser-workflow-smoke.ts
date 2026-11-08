import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { workflowFixture } from './workflow-fixture.js';
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await workflowFixture({ appFactory: createApp });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const coder = env.store.createTask({
    repositoryId: env.repositoryRecord.id,
    agentId: 'codex-1',
    executionMode: 'write',
    title: 'Browser workflow fixture',
    prompt: 'WRITE_FIXTURE',
  });
  const address = await env.app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  // Review fixtures inspect the optional visual office explicitly.
  await page.locator('.office-visual > summary').click();
  const officeArtifacts = process.env.AI_OFFICE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'ai-office-v4');
  await mkdir(officeArtifacts, { recursive: true });
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'approval',
    { timeout: 10000 },
  );
  await page
    .locator('.studio-kicker')
    .first()
    .evaluate((node) => {
      node.textContent = 'TEST FIXTURE / APPROVAL PENDING';
    });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 });
    await page.getByRole('region', { name: 'Shared Codex office' }).screenshot({
      path: join(officeArtifacts, `approval-${width === 1440 ? 'desktop' : 'mobile'}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: '◇ Inspect approval', exact: true }).click();
  await expect(page.locator('#workflows')).toBeFocused();
  const board = page.getByRole('region', { name: 'Workflow timeline', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Confirm workflow checkpoint' });
  // Manual refresh is a single read, not a mutation followed by a second read.
  // Pause polling to isolate the explicit request from the three-second timer.
  await board.getByRole('button', { name: 'Pause live updates' }).click();
  let manualRefreshes = 0;
  await page.route('**/api/workflows', async (route) => {
    manualRefreshes++;
    // Hold the response long enough to observe the in-progress button state.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Refresh workflow', exact: true })).toBeDisabled();
  await expect(board.getByRole('button', { name: 'Refresh workflow', exact: true })).toBeEnabled();
  assert.equal(manualRefreshes, 1, 'Manual refresh issued duplicate workflow list requests');
  await page.unroute('**/api/workflows');
  await board.getByRole('button', { name: 'Resume live updates' }).click();
  const gate = async (label: string, configure?: () => Promise<void>) => {
    await expect(board.getByRole('button', { name: label, exact: true })).toBeVisible({
      timeout: 45000,
    });
    await board.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Confirm checkpoint' })).toBeDisabled();
    if (configure) await configure();
    await dialog.getByRole('checkbox', { name: 'I approve this exact checkpoint' }).check();
    await dialog.getByRole('button', { name: 'Confirm checkpoint' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 45000 });
  };
  // Cancel and Escape must never approve, submit or write.
  await board.getByRole('button', { name: 'Approve Coder baseline' }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await env.get()).stages[0]!.state, 'awaiting_approval');
  assert.equal(env.store.queue().length, 0);
  await gate('Approve Coder baseline');
  // A failed timeline refresh must not leave an old approval checkpoint
  // actionable. Keep the last snapshot visible, but fail closed until recovery.
  const outagePattern = '**/api/workflows/*/timeline';
  await page.route(outagePattern, (route) => route.abort());
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
    await expect(
      board.getByText('Checkpoint actions are unavailable', { exact: false }),
    ).toBeVisible();
    await expect(board.getByRole('alert').first()).toContainText(
      'Refresh workflow before trying another action.',
    );
  } finally {
    await page.unroute(outagePattern);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  // A reverse proxy may send HTML rather than JSON on HTTP 502. Surface the
  // status, fail closed, and recover without reloading or retrying mutations.
  await page.route(outagePattern, (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }),
  );
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(board.getByRole('alert').first()).toContainText(
      'Workflow request failed: HTTP 502',
    );
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
  } finally {
    await page.unroute(outagePattern);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  // A 200 response can contain syntactically valid JSON with the wrong shape.
  // Do not accept it as a verified checkpoint or crash during rendering.
  const invalidCatalog = '**/api/workflows/qa-commands';
  await page.route(invalidCatalog, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"commands":"broken"}' }),
  );
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(board.getByRole('alert').first()).toContainText(
      'Invalid workflow response: malformed QA command catalog',
    );
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
  } finally {
    await page.unroute(invalidCatalog);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  // Even a structurally valid timeline may contain malformed nested metadata.
  // React would otherwise attempt to render an object as a checkpoint revision.
  await page.route(outagePattern, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        stages: payload.stages.map((stage: Record<string, unknown>, index: number) =>
          index === 0 ? { ...stage, evidenceRevision: { revision: 'invalid' } } : stage,
        ),
      },
    });
  });
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(board.getByRole('alert').first()).toContainText(
      'Invalid workflow response: malformed workflow timeline',
    );
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
    assert.equal(errors.length, 0, 'Malformed timeline must not crash React rendering');
  } finally {
    await page.unroute(outagePattern);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  // Independent GETs can each return valid JSON but disagree about the
  // workflow identity or persisted version. Never commit such a mixed read.
  const diagnosticsPattern = '**/api/workflows/*/diagnostics';
  await page.route(diagnosticsPattern, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, version: payload.version + 1 } });
  });
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(board.getByRole('alert').first()).toContainText(
      'Workflow checkpoint changed during refresh; retry to verify current version',
    );
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
  } finally {
    await page.unroute(diagnosticsPattern);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  await page.route(diagnosticsPattern, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, id: 'unrelated-workflow' } });
  });
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(board.getByRole('alert').first()).toContainText(
      'Workflow checkpoint identity mismatch; refresh to retry',
    );
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
    assert.equal(errors.length, 0, 'Mismatched snapshots must not crash React rendering');
  } finally {
    await page.unroute(diagnosticsPattern);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  // Equal versions do not make conflicting workflow states safe to approve.
  await page.route(diagnosticsPattern, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, state: 'conflicting-state' } });
  });
  try {
    await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await expect(board.getByRole('alert').first()).toContainText(
      'Workflow checkpoint state mismatch; refresh to retry',
    );
    await expect(
      board.getByRole('button', { name: 'Bind Coder task', exact: true }),
    ).toBeDisabled();
  } finally {
    await page.unroute(diagnosticsPattern);
  }
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  // Pausing live updates is useful for reading, not for approving a potentially
  // stale checkpoint. Resuming and verifying the snapshot restores actions.
  await board.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeDisabled();
  await board.getByRole('button', { name: 'Resume live updates' }).click();
  await expect(board.getByRole('button', { name: 'Bind Coder task', exact: true })).toBeEnabled();
  await gate('Bind Coder task', async () => {
    await dialog.getByLabel('Bind Coder task').selectOption(coder.id);
  });
  await gate('Start Coder');
  await gate('Capture Coder evidence');
  // A replay from a stale browser tab must leave the checkpoint unchanged.
  const captured = await env.get();
  const rejected = await page.request.post(address + env.url + '/approve-coder-evidence', {
    data: {
      version: captured.version - 1,
      confirmed: true,
      revision: captured.stages[0]!.evidence!.revision,
    },
  });
  assert.equal(rejected.status(), 409);
  assert.equal((await env.get()).version, captured.version);
  await gate('Approve Coder evidence');
  await gate('Approve Reviewer input');
  await gate('Prepare Reviewer snapshot');
  await gate('Start Reviewer');
  await expect(board).toContainText('Verified approved snapshot', { timeout: 45000 });
  assert.equal(
    await page.evaluate(
      () => (window as unknown as { workflowInjected?: boolean }).workflowInjected,
    ),
    undefined,
  );
  await expect(board.getByRole('button', { name: 'Start QA', exact: true })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('[data-agent-id="codex-2"]')).toHaveAttribute(
    'data-state',
    'approval',
    { timeout: 10000 },
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Workflows' })
    .click();
  // Another tab advancing a checkpoint must invalidate an already checked dialog.
  await board.getByRole('button', { name: 'Approve Reviewer result', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'I approve this exact checkpoint' }).check();
  const reviewed = await env.get();
  const concurrentApproval = await page.request.post(
    address + env.url + '/approve-reviewer-result',
    {
      data: {
        version: reviewed.version,
        confirmed: true,
        digest: reviewed.stages[1]!.report!.digest,
      },
    },
  );
  assert.equal(concurrentApproval.status(), 200);
  await expect(dialog.getByRole('alert')).toContainText('The workflow changed', { timeout: 10000 });
  await expect(dialog.getByRole('button', { name: 'Confirm checkpoint' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await gate('Approve QA command', async () => {
    await dialog.getByLabel('Approved QA command').selectOption('source');
  });
  await gate('Start QA');
  await expect(board).toContainText('QA assertions passed', { timeout: 45000 });
  await gate('Approve QA result');
  await expect(board.getByText(/^State: completed/)).toContainText('State: completed');
  const diagnostics = board.getByLabel('Workflow diagnostics');
  await expect(diagnostics).toContainText('Persisted checkpoint diagnostics');
  await expect(diagnostics).toContainText('no automatic restart');
  await page.reload();
  await expect(board.getByText(/^State: completed/)).toContainText('State: completed');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await page.locator('.task-row').filter({ hasText: 'Browser workflow fixture' }).click();
  const integrated = page.getByRole('region', { name: 'Workflow review results', exact: true });
  await expect(integrated).toContainText('Verified approved snapshot');
  await expect(integrated).toContainText('QA assertions passed');
  // A reviewer task belongs to the same workflow as its Coder task. The
  // task-scoped review route must find workflows linked through any stage.
  const reviewerTaskId = (await env.get()).stages[1]?.taskId;
  assert.ok(reviewerTaskId, 'Completed Reviewer stage must link its task');
  await page.goto(`${address}/#task/${encodeURIComponent(reviewerTaskId)}/workflow`);
  const reviewerAnchor = page.locator(`#task-workflow-${encodeURIComponent(reviewerTaskId)}`);
  await expect(reviewerAnchor).toBeFocused();
  await expect(
    reviewerAnchor.getByRole('region', { name: 'Workflow review results', exact: true }),
  ).toContainText('QA assertions passed');
  await page.goto(`${address}/#task/${encodeURIComponent(coder.id)}/workflow`);
  const coderAnchor = page.locator(`#task-workflow-${encodeURIComponent(coder.id)}`);
  await expect(coderAnchor).toBeFocused();
  const coderWorkflow = coderAnchor.getByRole('region', {
    name: 'Workflow review results',
    exact: true,
  });
  await expect(coderWorkflow).toContainText('QA assertions passed');
  const artifacts =
    process.env.AI_OFFICE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'ai-office-v07-browser');
  await mkdir(artifacts, { recursive: true });
  await coderWorkflow.screenshot({ path: join(artifacts, 'workflow-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(coderWorkflow).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await coderWorkflow.screenshot({ path: join(artifacts, 'workflow-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Resolve a delayed response for another selection after the current one has rendered.
  const alternate = await env.send('POST', '/api/workflows', {
    repositoryId: env.repositoryRecord.id,
    coderAgentId: 'codex-1',
    reviewerAgentId: 'codex-2',
  });
  assert.equal(alternate.statusCode, 201);
  const otherId = alternate.json().id;
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Workflows' })
    .click();
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await expect(board.getByLabel('Workflow', { exact: true }).locator('option')).toHaveCount(2);
  const operationsQueue = board.getByLabel('Workflow operations queue');
  await expect(operationsQueue).toContainText(reviewed.id.slice(0, 8));
  await expect(operationsQueue).toContainText(otherId.slice(0, 8));
  await board.getByLabel('Find workflow by ID or repository').fill(otherId);
  await expect(operationsQueue.getByRole('button')).toHaveCount(1);
  await board.getByLabel('Workflow state').selectOption('completed');
  await expect(board.getByText('No workflows match the current filters.')).toBeVisible();
  await board.getByRole('button', { name: 'Clear workflow filters' }).click();
  await expect(board.getByLabel('Workflow state')).toHaveValue('all');
  await expect(board.getByLabel('Find workflow by ID or repository')).toHaveValue('');
  await expect(operationsQueue.getByRole('button')).toHaveCount(2);
  await board.getByLabel('Sort workflows').selectOption('oldest');
  await board.getByLabel('Sort workflows').selectOption('attention');
  await board.getByRole('checkbox', { name: /Needs attention/ }).check();
  await expect(operationsQueue).toContainText(otherId.slice(0, 8));
  await board.getByRole('checkbox', { name: /Needs attention/ }).uncheck();
  await board.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(board.getByRole('button', { name: 'Resume live updates' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(board.getByLabel('Workflow operations overview')).toContainText(
    'Live updates paused',
  );
  // Pausing background polls must not leave a newly selected checkpoint blank.
  await board.getByLabel('Workflow', { exact: true }).selectOption(otherId);
  await expect(board.getByText(/^State: active/)).toBeVisible({ timeout: 10000 });
  await board.getByLabel('Workflow', { exact: true }).selectOption(reviewed.id);
  await expect(board.getByText(/^State: completed/)).toBeVisible({ timeout: 10000 });
  // Clicking the already selected queue entry must preserve the loaded timeline.
  await operationsQueue.getByRole('button', { name: new RegExp(reviewed.id.slice(0, 8)) }).click();
  await expect(board.getByText(/^State: completed/)).toBeVisible();
  await expect(board.getByRole('button', { name: 'Resume live updates' })).toBeVisible();
  await board.getByRole('button', { name: 'Refresh workflow' }).click();
  await board.getByRole('button', { name: 'Resume live updates' }).click();
  await expect(board.getByRole('button', { name: 'Pause live updates' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finishRoute!: () => void;
  const routeSettled = new Promise<void>((resolve) => {
    finishRoute = resolve;
  });
  const routePattern = `**/api/workflows/${otherId}/timeline`;
  await page.route(routePattern, async (route) => {
    try {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    } catch (cause) {
      // Changing workflows aborts the old GET. A cancelled request cannot
      // deliver a response event, so waiting for waitForResponse would hang.
      if (!route.request().failure()) throw cause;
    } finally {
      finishRoute();
    }
  });
  try {
    const requested = page.waitForRequest((request) =>
      request.url().endsWith(`/workflows/${otherId}/timeline`),
    );
    await board.getByLabel('Workflow', { exact: true }).selectOption(otherId);
    await requested;
    // A slow checkpoint must show progress rather than an unexplained blank panel.
    await expect(board.getByText('Loading selected workflow checkpoint…')).toBeVisible();
    await expect(board.getByText(/^State: completed/)).toHaveCount(0);
    await board.getByLabel('Workflow', { exact: true }).selectOption(reviewed.id);
    await expect(board.getByText(/^State: completed/)).toContainText('State: completed');
    await expect(board.getByText('Loading selected workflow checkpoint…')).toHaveCount(0);
    release();
    await routeSettled;
    await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(reviewed.id);
    await expect(board.getByText(/^State: completed/)).toContainText('State: completed');
  } finally {
    release();
    await page.unroute(routePattern);
  }
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'approval',
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).click();
  await page.getByRole('button', { name: '◇ Inspect approval', exact: true }).click();
  await board.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(otherId);
  await expect(board.getByText(/^State: active/)).toBeVisible();
  await expect(board.getByRole('button', { name: 'Resume live updates' })).toBeVisible();
  // Creating another workflow must select the newly created checkpoint, not
  // revert to the previously selected workflow from a stale refresh closure.
  await board.getByRole('button', { name: 'Resume live updates' }).click();
  const newCoder = env.store.createTask({
    repositoryId: env.repositoryRecord.id,
    agentId: 'codex-1',
    executionMode: 'write',
    title: 'Second browser workflow fixture',
    prompt: 'WRITE_FIXTURE',
  });
  await board.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  const beforeCreate = (await (await page.request.get(address + '/api/workflows')).json()) as {
    id: string;
  }[];
  await board.getByText('Create workflow', { exact: true }).click();
  await board.getByLabel('Coder task').selectOption(newCoder.id);
  await board.getByLabel('Reviewer profile').selectOption('codex-2');
  await board.getByRole('button', { name: 'Create gated workflow' }).click();
  await expect
    .poll(async () => {
      const list = (await (await page.request.get(address + '/api/workflows')).json()) as {
        id: string;
      }[];
      return list.length;
    })
    .toBe(beforeCreate.length + 1);
  const afterCreate = (await (await page.request.get(address + '/api/workflows')).json()) as {
    id: string;
  }[];
  const newWorkflow = afterCreate.find((item) => !beforeCreate.some((old) => old.id === item.id));
  assert.ok(newWorkflow);
  await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(newWorkflow.id);
  // The create mutation may select its workflow before its explicit refresh
  // settles. Do not count that legitimate manual GET as automatic polling.
  await expect(board.getByRole('button', { name: 'Refresh workflow', exact: true })).toBeEnabled();
  // Isolate automatic polling from earlier manual refreshes. A slow GET
  // must remain the only list request until it settles, even after the 3s tick.
  await board.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(board.getByRole('button', { name: 'Resume live updates' })).toBeVisible();
  // Drain the create workflow's explicit refresh before measuring automatic
  // polling. Hold its list GET so even a fast macOS runner observes the
  // disabled state; checking it after an unblocked click races the response.
  const refreshButton = board.getByRole('button', { name: 'Refresh workflow', exact: true });
  const manualListPattern = '**/api/workflows';
  let releaseManualRefresh!: () => void;
  const manualRefreshHeld = new Promise<void>((resolve) => {
    releaseManualRefresh = resolve;
  });
  await page.route(manualListPattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await manualRefreshHeld;
    await route.continue();
  });
  try {
    const manualRequest = page.waitForRequest(
      (request) => request.url().endsWith('/api/workflows') && request.method() === 'GET',
    );
    const manualResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/workflows') && response.request().method() === 'GET',
    );
    await refreshButton.click();
    await manualRequest;
    await expect(refreshButton).toBeDisabled();
    releaseManualRefresh();
    await manualResponse;
    await expect(refreshButton).toBeEnabled({ timeout: 15000 });
  } finally {
    releaseManualRefresh();
    await page.unroute(manualListPattern);
  }
  // Freeze browser timers so a slow macOS runner cannot turn a 3-second
  // coalescing assertion into a 15-second request-deadline assertion.
  // Advance exactly one polling interval while the first GET is held.
  await page.clock.pauseAt(new Date());
  const slowListPattern = '**/api/workflows';
  let observedListRequests = 0;
  let releaseFirstList!: () => void;
  const firstListHeld = new Promise<void>((resolve) => {
    releaseFirstList = resolve;
  });
  await page.route(slowListPattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    observedListRequests++;
    try {
      if (observedListRequests === 1) await firstListHeld;
      else await new Promise((resolve) => setTimeout(resolve, 3500));
      if (route.request().failure()) return;
      await route.continue();
    } catch (cause) {
      // A selection change can cancel the intercepted GET while this route
      // is held. Playwright may already have handled the cancelled route
      // before request.failure() becomes observable.
      if (cause instanceof Error && cause.message.includes('Route is already handled!')) return;
      if (!route.request().failure()) throw cause;
    }
  });
  try {
    const external = await env.send('POST', '/api/workflows', {
      repositoryId: env.repositoryRecord.id,
      coderAgentId: 'codex-1',
      reviewerAgentId: 'codex-2',
    });
    assert.equal(external.statusCode, 201);
    const externalId = external.json().id as string;
    const firstSlowPoll = page.waitForRequest(
      (request) => request.url().endsWith('/api/workflows') && request.method() === 'GET',
    );
    await board.getByRole('button', { name: 'Resume live updates' }).click();
    await firstSlowPoll;
    await page.clock.runFor(3200);
    assert.equal(
      observedListRequests,
      1,
      'The next automatic tick must coalesce while the first slow list GET is pending',
    );
    releaseFirstList();
    await page.clock.resume();
    await expect(operationsQueue).toContainText(externalId.slice(0, 8), { timeout: 15000 });
    // A slow background refresh must not replace the explicit selection.
    await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(newWorkflow.id);
    // Selecting another workflow while a later slow poll is pending must
    // invalidate the previous checkpoint and preserve the new selection.
    await expect.poll(() => observedListRequests).toBeGreaterThanOrEqual(2);
    await operationsQueue.getByRole('button', { name: new RegExp(otherId.slice(0, 8)) }).click();
    await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(otherId);
    await expect(board.getByText(/^State: active/)).toBeVisible({ timeout: 15000 });
    await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(otherId);
  } finally {
    releaseFirstList();
    await page.clock.resume();
    await page.unroute(slowListPattern);
  }
  // Mobile operations must remain within the viewport and expose real touch targets.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(operationsQueue).toBeVisible();
  const queueLayout = await operationsQueue.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    buttonHeights: Array.from(
      node.querySelectorAll('button'),
      (button) => button.getBoundingClientRect().height,
    ),
  }));
  assert.ok(queueLayout.buttonHeights.length > 0, 'Mobile workflow queue has no actions');
  assert.ok(
    queueLayout.scrollWidth <= queueLayout.clientWidth + 1,
    'Mobile workflow queue overflows horizontally',
  );
  assert.ok(
    queueLayout.buttonHeights.every((height) => height >= 44),
    'Mobile workflow actions must have 44px touch targets',
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  assert.equal((await env.get()).state, 'completed');
  assert.equal(await readFile(join(env.repository, 'README.md'), 'utf8'), '# Disposable example\n');
  assert.deepEqual(errors, []);
  console.log(
    `Workflow browser E2E passed: approval gates, cancellation, stale request/dialog and delayed-selection rejection, SDK snapshot, sandboxed QA, persisted reports, Review Center, XSS escaping and mobile layout. Screenshots: ${artifacts}`,
  );
} finally {
  await browser?.close();
  await env.cleanup();
}
