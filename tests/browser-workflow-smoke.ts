import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  await gate('Approve Reviewer result');
  await gate('Approve QA command', async () => {
    await dialog.getByLabel('Approved QA command').selectOption('source');
  });
  await gate('Start QA');
  await expect(board).toContainText('QA assertions passed', { timeout: 45000 });
  await gate('Approve QA result');
  await expect(board.getByRole('status')).toContainText('State: completed');
  await page.reload();
  await expect(board.getByRole('status')).toContainText('State: completed');
  await page.getByRole('button', { name: /Browser workflow fixture/ }).click();
  const integrated = page.getByRole('region', { name: 'Workflow review results', exact: true });
  await expect(integrated).toContainText('Verified approved snapshot');
  await expect(integrated).toContainText('QA assertions passed');
  const artifacts = process.env.AI_OFFICE_BROWSER_ARTIFACTS ?? '/private/tmp/ai-office-v07-browser';
  await mkdir(artifacts, { recursive: true });
  await integrated.screenshot({ path: join(artifacts, 'workflow-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(integrated).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await integrated.screenshot({ path: join(artifacts, 'workflow-mobile.png') });
  assert.equal((await env.get()).state, 'completed');
  assert.equal(await readFile(join(env.repository, 'README.md'), 'utf8'), '# Disposable example\n');
  assert.deepEqual(errors, []);
  console.log(
    `Workflow browser E2E passed: all approval gates, cancellation, stale request rejection, SDK snapshot, sandboxed QA, persisted reports, Review Center, XSS escaping and mobile layout. Screenshots: ${artifacts}`,
  );
} finally {
  await browser?.close();
  await env.cleanup();
}
