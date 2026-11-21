import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { sandbox } from './helpers.js';

// Real Fastify + SQLite + compiled UI. All task data is an explicitly labelled
// disposable fixture; this suite never starts a provider or enables delivery.
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await sandbox();
const second = await sandbox();
const app = await createApp(env.manager);
const artifacts =
  process.env.AI_OFFICE_REFERENCE_ARTIFACTS ?? join(tmpdir(), 'ai-office-issue-201-evidence');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  reducedMotion: 'reduce',
});
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const registered = await page.request.post(`${address}/api/repositories`, {
    data: { path: env.repository },
  });
  assert.equal(registered.status(), 201);
  const repo = (await registered.json()) as { id: string };
  const secondRegistered = await page.request.post(`${address}/api/repositories`, {
    data: { path: second.repository },
  });
  assert.equal(secondRegistered.status(), 201);
  const secondRepo = (await secondRegistered.json()) as { id: string };
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Improve animation system',
    prompt:
      'Review animation performance and identify maintainability issues.\nPreserve existing transitions and report findings.',
    agentId: 'codex-1',
  });
  env.store.updateTask(task.id, {
    state: 'completed',
    result: 'Fixture review complete. No provider was started.',
    changedFiles: [{ path: 'src/animation.ts', status: ' M' }],
  });
  env.store.addEvent(task.id, 'state', 'Review completed');
  env.store.createTask({
    repositoryId: repo.id,
    title: 'Verify mobile navigation',
    prompt: 'Inspect responsive navigation.',
    agentId: 'codex-2',
  });
  const failure = env.store.createTask({
    repositoryId: repo.id,
    title: 'Check release readiness',
    prompt: 'Review release requirements.',
  });
  env.store.updateTask(failure.id, {
    state: 'failed',
    error: 'Fixture failure: verification unavailable.',
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const banner = document.createElement('div');
      banner.textContent = 'TEST FIXTURE · Issue #201 · disposable SQLite data · no model calls';
      banner.style.cssText =
        'padding:6px 12px;background:#253653;color:#e5edff;text-align:right;font:11px system-ui;pointer-events:none';
      document.body.append(banner);
    });
  });
  await page.goto(address);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('button', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav).not.toContainText('Lead Agent');
  await expect(nav).not.toContainText('Project Context');
  await page.getByLabel('Current repository').selectOption(secondRepo.id);
  await expect(page.locator('.repo-link[aria-pressed="true"]')).toHaveCount(1);
  await page.getByLabel('Current repository').selectOption(repo.id);
  const taskUrl = `${address}/#task/${encodeURIComponent(task.id)}`;
  for (const width of [320, 390, 900, 1440, 1920]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1080 });
    for (const [route, label] of [
      ['#overview', 'overview'],
      ['#tasks', 'tasks'],
      ['#workflows', 'workflows'],
      ['#agents', 'agents'],
      ['#settings', 'settings'],
      [`#task/${task.id}/overview`, 'task-details'],
    ] as const) {
      await page.goto(`${address}/${route}`);
      await expect(page.getByLabel('Current repository')).toHaveValue(repo.id);
      if (label === 'task-details')
        await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      else
        await expect(page.locator('.shell')).toHaveAttribute(
          'data-page',
          label === 'overview' ? 'office' : label,
        );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      if (width >= 1440 && label === 'settings') {
        assert.ok((await page.locator('.settings-subnav').boundingBox())!.width <= 230);
        assert.ok((await page.getByLabel('Absolute repository path').boundingBox())!.height < 60);
        const limits = (await page.locator('.settings-limits').boundingBox())!;
        const body = (await page.locator('.settings-body').boundingBox())!;
        assert.ok(limits.x > body.x + body.width - 1, 'Budget card must occupy the right column');
      }
      if (width >= 1440 && label === 'task-details') {
        assert.ok(
          (await page.locator('#task-workspace').boundingBox())!.x < 300,
          'Details must fill the content area',
        );
      }
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        window.scrollTo(0, 0);
      });
      if (width !== 320)
        await page.screenshot({ path: join(artifacts, `${label}-${width}.png`), fullPage: true });
    }
  }
  await page.goto(`${taskUrl}/overview`);
  await page.reload();
  await expect(page.locator('#task-workspace')).toBeFocused();
  const overviewTab = page.getByRole('tab', { name: 'Overview', exact: true });
  await overviewTab.focus();
  await page.keyboard.press('ArrowRight');
  const executionTab = page.getByRole('tab', { name: 'Execution', exact: true });
  await expect(executionTab).toBeFocused();
  await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(executionTab).toHaveAttribute('aria-selected', 'true');
  await expect(executionTab).toBeFocused();
  await expect(page.getByText('Fixture review complete. No provider was started.')).toBeVisible();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByText('src/animation.ts', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goBack();
  await expect(executionTab).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.locator('#task-content-history')).toContainText('Review completed');
  await expect(page.getByRole('tab', { name: 'Review', exact: true })).toBeDisabled();
  await page.goto(`${address}/#task/missing/overview`);
  await expect(page.getByRole('alert')).toContainText('This task is no longer available');
  await page.getByRole('button', { name: 'Back to task history' }).click();
  await expect(page).toHaveURL(/#task-history$/);
  await page.goto(`${address}/#settings/integrations`);
  await page.getByLabel('Authentication mode').selectOption('api-key');
  await expect
    .poll(async () =>
      (await page.request.get(`${address}/api/dashboard`))
        .json()
        .then((data) => data.connection.mode),
    )
    .toBe('api-key');
  await page.reload();
  await expect(page.getByLabel('Authentication mode')).toHaveValue('api-key');
  await page.getByLabel('Authentication mode').selectOption('local-cli-chatgpt');
  await expect(page.getByTestId('codex-connection-status')).toHaveText('Available');
  await page.getByRole('link', { name: 'Execution', exact: true }).click();
  await expect(page).toHaveURL(/#settings\/execution$/);
  await page.reload();
  await expect(page.locator('#settings-content')).toContainText('Balanced / Economy modes');
  await page.goBack();
  await expect(page.getByLabel('Authentication mode')).toBeVisible();
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await page.getByLabel('Absolute repository path').fill('/nonexistent/issue-201');
  await page.getByRole('button', { name: /^Register/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  // Network interruption retains an honest stale snapshot and disables mutations.
  await page.route('**/api/dashboard', (route) => route.abort());
  await expect(page.locator('.topbar .connection')).toContainText('disconnected', {
    timeout: 10000,
  });
  await expect(page.getByRole('button', { name: /^Register/ })).toBeDisabled();
  await page.screenshot({
    path: join(artifacts, 'settings-disconnected-1920.png'),
    fullPage: true,
  });
  await page.unroute('**/api/dashboard');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.locator('.topbar .connection')).not.toContainText('disconnected');
  await page.goto(`${taskUrl}/overview`);
  await page.route('**/api/dashboard', (route) => route.abort());
  await expect(page.locator('#task-workspace')).toContainText(
    'Disconnected. Task details show the last received snapshot.',
    { timeout: 10000 },
  );
  await page.screenshot({
    path: join(artifacts, 'task-details-disconnected-1920.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `Reference UI browser checks passed: 5 widths, 6 routes, detail tabs, keyboard focus, history, settings persistence, errors, disconnect. Evidence: ${artifacts}`,
  );
} finally {
  await browser.close();
  await app.close();
  await env.cleanup();
  await second.cleanup();
}
