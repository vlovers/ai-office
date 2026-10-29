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
  const artifacts =
    process.env.AI_OFFICE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'ai-office-v07-browser');
  await mkdir(artifacts, { recursive: true });
  await integrated.screenshot({ path: join(artifacts, 'workflow-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(integrated).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await integrated.screenshot({ path: join(artifacts, 'workflow-mobile.png') });
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
  await board.getByLabel('Workflow state').selectOption('all');
  await board.getByLabel('Find workflow by ID or repository').fill('');
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
  const routePattern = `**/api/workflows/${otherId}/timeline`;
  await page.route(routePattern, async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    const requested = page.waitForRequest((request) =>
      request.url().endsWith(`/workflows/${otherId}/timeline`),
    );
    await board.getByLabel('Workflow', { exact: true }).selectOption(otherId);
    await requested;
    await board.getByLabel('Workflow', { exact: true }).selectOption(reviewed.id);
    await expect(board.getByText(/^State: completed/)).toContainText('State: completed');
    const delayed = page.waitForResponse((response) =>
      response.url().endsWith(`/workflows/${otherId}/timeline`),
    );
    release();
    await (await delayed).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(reviewed.id);
    await expect(board.getByText(/^State: completed/)).toContainText('State: completed');
  } finally {
    release();
    await page.unroute(routePattern);
  }
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'approval',
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).click();
  await board.getByRole('button', { name: 'Pause live updates' }).click();
  await page.getByRole('button', { name: '◇ Inspect approval', exact: true }).click();
  await expect(board.getByLabel('Workflow', { exact: true })).toHaveValue(otherId);
  await expect(board.getByText(/^State: active/)).toBeVisible();
  await expect(board.getByRole('button', { name: 'Pause live updates' })).toBeVisible();
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
