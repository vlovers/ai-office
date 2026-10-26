import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { sandbox } from './helpers.js';
import { TaskManager } from '../src/server/manager.js';
import { CodexProvider } from '../src/server/providers/codex.js';
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await sandbox();
const manager = new TaskManager(
  env.store,
  env.providers,
  env.auth,
  undefined,
  undefined,
  undefined,
  {
    createProvider: (id) =>
      new CodexProvider({ home: join(env.root, 'workers', id), auth: env.auth }),
    concurrency: 2,
  },
);
const app = await createApp(manager);
const artifacts = process.env.AI_OFFICE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'ai-office-v4');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: 'reduce',
});
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  // Every screenshot is clearly a disposable application fixture, never production telemetry.
  await page.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      const banner = document.createElement('div');
      banner.textContent = 'TEST FIXTURE · Office V4 · disposable data · no model calls';
      banner.style.cssText =
        'padding:8px 16px;background:#e8d6ad;color:#26363f;text-align:center;font:12px system-ui;position:relative;z-index:5';
      document.body.prepend(banner);
    }),
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const scene = page.getByRole('region', { name: 'Shared Codex office' });
  const capture = async (name: string) => {
    // Scene screenshots are captured on Office even when a task was started
    // from Tasks. Restore the previous screen for subsequent user actions.
    const previousScreen = await page.locator('.shell').getAttribute('data-screen');
    if (previousScreen !== 'office') {
      await page.getByRole('navigation', { name: 'Dashboard sections' })
        .getByRole('link', { name: 'Office' }).click();
    }
    await page
      .locator('.studio-kicker')
      .first()
      .evaluate((node, label) => {
        node.textContent = label;
      }, `TEST FIXTURE / ${name.toUpperCase()}`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 });
      await expect(scene).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await scene.screenshot({
        path: join(artifacts, `${name}-${width === 1440 ? 'desktop' : 'mobile'}.png`),
      });
      await page.screenshot({
        path: join(artifacts, `${name}-${width === 1440 ? 'desktop' : 'mobile'}-viewport.png`),
      });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    if (previousScreen && previousScreen !== 'office') {
      await page.getByRole('navigation', { name: 'Dashboard sections' })
        .getByRole('link', { name: previousScreen === 'tasks' ? 'Tasks' : previousScreen === 'workflows' ? 'Workflows' : previousScreen === 'team' ? 'Team' : 'Settings' }).click();
      await expect(page.locator('.shell')).toHaveAttribute('data-screen', previousScreen);
    }
  };
  let releaseLoading!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await page.route('**/api/dashboard', async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(address, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Opening your office…')).toBeVisible();
  await capture('loading');
  releaseLoading();
  await page.unrouteAll({ behavior: 'wait' });
  // The five workspaces must be navigable without losing the active office scene.
  const navigation = page.getByRole('navigation', { name: 'Dashboard sections' });
  for (const [label, screen, visibleSelector] of [
    ['Tasks', 'tasks', '#task-history'],
    ['Workflows', 'workflows', '#workflow-timeline'],
    ['Team', 'team', '#agent-studio'],
    ['Settings', 'settings', '#repositories'],
    ['Office', 'office', '.office-scene'],
  ] as const) {
    await navigation.getByRole('link', { name: new RegExp(label) }).click();
    await expect(page.locator('.shell')).toHaveAttribute('data-screen', screen);
    await expect(page.locator(visibleSelector)).toBeVisible();
    await expect(
      page.locator('nav[aria-label="Dashboard sections"] a[aria-current="page"]'),
    ).toHaveCount(1);
  }
  // A reload must restore the active workspace rather than silently hiding
  // a running Workflow timeline behind the default Office screen.
  await navigation.getByRole('link', { name: 'Workflows' }).click();
  await page.reload();
  await expect(page.locator('.shell')).toHaveAttribute('data-screen', 'workflows');
  await expect(page.locator('#workflow-timeline')).toBeVisible();
  await navigation.getByRole('link', { name: 'Office' }).click();
  // Capture each workspace at desktop and phone sizes; assertions detect hidden
  // destinations and horizontal overflow before any visual review.
  for (const [label, screen] of [
    ['Office', 'office'],
    ['Tasks', 'tasks'],
    ['Workflows', 'workflows'],
    ['Team', 'team'],
    ['Settings', 'settings'],
  ] as const) {
    await navigation.getByRole('link', { name: new RegExp(label) }).click();
    await expect(page.locator('.shell')).toHaveAttribute('data-screen', screen);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1100 : 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(artifacts, `workspace-${screen}-${width === 1440 ? 'desktop' : 'mobile'}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await navigation.getByRole('button', { name: /New task/ }).click();
  await expect(page.locator('.shell')).toHaveAttribute('data-screen', 'tasks');
  await expect(page.locator('#compose')).toBeVisible();
  await navigation.getByRole('link', { name: 'Office' }).click();
  await expect(scene).toBeVisible();
  // Focus mode must not leak into unrelated screens.
  await page.evaluate(() => {
    const shell = document.querySelector('.shell');
    shell?.classList.add('focus-mode');
  });
  await navigation.getByRole('link', { name: 'Workflows' }).click();
  await expect(page.locator('#workflow-timeline')).toBeVisible();
  await navigation.getByRole('link', { name: 'Team' }).click();
  await expect(page.locator('#agent-studio')).toBeVisible();
  await navigation.getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('#repositories')).toBeVisible();
  await navigation.getByRole('link', { name: 'Office' }).click();
  await expect(scene).toBeVisible();
  await page.evaluate(() => document.querySelector('.shell')?.classList.remove('focus-mode'));
  await expect(page.locator('.office-workstation')).toHaveCount(2);
  await expect(page.locator('.office-workstation').first()).toHaveAttribute('data-state', 'idle');
  await capture('two-idle');
  // Actual archive operation yields the real zero-profile office, no fake runtime objects.
  for (const profile of env.store.agents())
    env.store.editAgent(profile.id, profile.revision, { archived: true });
  await expect(page.locator('.office-workstation')).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByText('Your office is ready for company.')).toBeVisible();
  await capture('no-agents');
  for (const profile of env.store.agents())
    env.store.editAgent(profile.id, profile.revision, { archived: false });
  const extras = Array.from({ length: 4 }, (_, i) =>
    env.store.createAgent({
      name: ['Fern', 'Sage', 'Iris', 'Moss'][i]!,
      role: i === 0 ? 'Reviewer' : 'Coding assistant',
      description: 'Office visual fixture',
      instructions: '',
      model: 'fixture-model',
      maximumMode: 'read-only',
    }),
  );
  await expect(page.locator('.studio-agent')).toHaveCount(6, { timeout: 10000 });
  await expect(page.locator('.office-workstation')).toHaveCount(4);
  await page.locator('.studio-agent').last().click();
  await expect(
    page.locator(`.office-workstation[data-agent-id="${extras[3]!.id}"]`),
  ).toHaveAttribute('aria-pressed', 'true');
  await capture('multiple-agents');
  // Queue and execution use the manager/SDK fixture through the normal UI in browser-smoke.
  // These persisted records exercise the saved outcome view with explicit fixture names.
  await navigation.getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('#repositories')).toBeVisible();
  await page.getByLabel('Absolute repository path').fill(env.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await navigation.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.locator('#compose')).toBeVisible();
  await page.getByLabel('Assign to agent').selectOption('codex-1');
  await page.getByLabel('Task title').fill('FIXTURE · held SDK reasoning');
  await page.getByLabel('What should the agent work on?').fill('WAIT_FIXTURE');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'thinking',
    { timeout: 15000 },
  );
  await capture('active');
  await page.getByLabel('Assign to agent').selectOption('codex-2');
  await page.getByLabel('Task title').fill('FIXTURE · submitted queue');
  await page.getByLabel('What should the agent work on?').fill('Review later');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  const queue = page.getByRole('region', { name: 'Live task queue' });
  await expect(queue).toContainText('FIXTURE · submitted queue');
  await expect(page.locator('[data-agent-id="codex-2"]')).toHaveAttribute('data-state', 'queued');
  await queue.getByRole('button', { name: /FIXTURE · submitted queue/ }).click();
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  await capture('queued');
  await page.getByRole('button', { name: 'Cancel queued task' }).click();
  await manager.stop(env.store.tasks().find((task) => task.state === 'running')!.id);
  await page.getByLabel('Assign to agent').selectOption('codex-1');
  await page.getByLabel('Task title').fill('FIXTURE · saved completion');
  await page.getByLabel('What should the agent work on?').fill('Review the README.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'completed',
    { timeout: 15000 },
  );
  await capture('completed');
  await page.getByLabel('Task title').fill('FIXTURE · provider failure');
  await page.getByLabel('What should the agent work on?').fill('FAIL_FIXTURE');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute('data-state', 'error', {
    timeout: 15000,
  });
  await capture('failure');
  // CSV export uses the current history filters and contains no prompt or transcript content.
  // Task history lives on its own workspace after the unified navigation rebuild.
  await navigation.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.locator('.shell')).toHaveAttribute('data-screen', 'tasks');
  const history = page.locator('#task-history');
  await expect(history).toBeVisible();
  await history.getByLabel('Search tasks').fill('FIXTURE · provider failure');
  await expect(history.getByRole('button', { name: /Export filtered CSV/ })).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    history.getByRole('button', { name: /Export filtered CSV/ }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'ai-office-task-history.csv');
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /FIXTURE · provider failure/);
  assert.doesNotMatch(csv, /FIXTURE · saved completion/);
  assert.doesNotMatch(csv, /FAIL_FIXTURE|WAIT_FIXTURE/);
  await history.getByLabel('Search tasks').fill('');

  // Simulate transport failure while retaining genuine persisted application snapshots.
  await page.route('**/api/dashboard', (route) => route.abort());
  await expect(page.locator('.studio-notice').first()).toContainText('Connection interrupted', {
    timeout: 10000,
  });
  await expect(page.getByRole('button', { name: 'Assign a task', exact: true })).toBeDisabled();
  await capture('disconnected');
  await page.unroute('**/api/dashboard');
  await expect(page.locator('.studio-notice')).toHaveCount(0, { timeout: 10000 });
  // Recovery must restore a usable Tasks workspace and its persisted records,
  // not merely dismiss the disconnected banner.
  await expect(page.locator('.shell')).toHaveAttribute('data-screen', 'tasks');
  await expect(history).toBeVisible();
  await expect(history).toContainText('FIXTURE · provider failure');
  await expect(history.getByRole('button', { name: /Export filtered CSV/ })).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log(
    `Office V4 browser passed: zero/two/six profiles, overflow selection, real SDK fixture reasoning, submitted queue exact-task selection, failure, disconnected snapshot, reduced motion and desktop/mobile overflow. Screenshots: ${artifacts}`,
  );
} finally {
  await browser.close();
  await app.close();
  await env.cleanup();
}
