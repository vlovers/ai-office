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
  await expect(page.locator('.studio-agent').last()).toHaveAttribute('aria-pressed', 'true');
  // Workstation selection is local to Office, not an implicit route to Agents.
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Office' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(scene).toBeVisible();
  await capture('multiple-agents');
  // Queue and execution use the manager/SDK fixture through the normal UI in browser-smoke.
  // These persisted records exercise the saved outcome view with explicit fixture names.
  const navigate = async (destination: 'Office' | 'Tasks' | 'Settings') => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: destination })
      .click();
  };
  // On a 320px screen the five destinations must remain keyboard-accessible
  // even when the horizontal strip clips the first or last item.
  await page.setViewportSize({ width: 320, height: 720 });
  await navigate('Settings');
  const mobileNav = page.getByRole('navigation', { name: 'Main navigation' });
  const officeNavButton = mobileNav.getByRole('button', { name: 'Office' });
  const settingsNavButton = mobileNav.getByRole('button', { name: 'Settings' });
  await expect(settingsNavButton).toBeInViewport();
  await settingsNavButton.focus();
  const beforeKeyboardScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Home');
  await expect(officeNavButton).toBeFocused();
  await expect(officeNavButton).toBeInViewport();
  await expect(page).toHaveURL(/#settings$/);
  await page.keyboard.press('End');
  await expect(settingsNavButton).toBeFocused();
  await expect(settingsNavButton).toBeInViewport();
  await expect(page.evaluate(() => window.scrollY)).resolves.toBe(beforeKeyboardScroll);
  await page.keyboard.press('ArrowRight');
  await expect(officeNavButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#office$/);
  await page.keyboard.press('ArrowLeft');
  await expect(settingsNavButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#settings$/);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await navigate('Office');
  // A stale task URL must offer a usable exit instead of leaving the user in
  // Focus Mode with an empty session and an unrelated history fragment.
  await page.evaluate(() => {
    window.location.hash = '#task/missing-fixture/session';
  });
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await page.getByRole('button', { name: 'Back to task history' }).click();
  await expect(page).toHaveURL(/#task-history$/);
  await expect(page.locator('.shell')).not.toHaveClass(/focus-mode/);
  await expect(page.locator('#task-history')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await navigate('Office');
  const newTask = async (agentId: string, title: string, prompt: string) => {
    await navigate('Tasks');
    await page.getByRole('button', { name: '+ New task' }).click();
    await page.getByLabel('Assign to agent').selectOption(agentId);
    await page.getByLabel('Task title').fill(title);
    await page.getByLabel('What should the agent work on?').fill(prompt);
    await page.getByRole('button', { name: 'Create task' }).click();
    await page.getByRole('button', { name: 'Start task' }).click();
    await navigate('Office');
  };
  // Switching to the task composer must be a real history entry. Back and
  // Forward restore both the destination and the active task panel.
  await navigate('Tasks');
  await page.getByRole('button', { name: '+ New task' }).click();
  await expect(page).toHaveURL(/#compose$/);
  await page.goBack();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.locator('.shell')).toHaveAttribute('data-task-panel', 'details');
  await page.goForward();
  await expect(page).toHaveURL(/#compose$/);
  await expect(page.locator('.shell')).toHaveAttribute('data-task-panel', 'new');
  await navigate('Settings');
  await page.getByLabel('Absolute repository path').fill(env.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await newTask('codex-1', 'FIXTURE · held SDK reasoning', 'WAIT_FIXTURE');
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'thinking',
    { timeout: 15000 },
  );
  await capture('active');
  await newTask('codex-2', 'FIXTURE · submitted queue', 'Review later');
  const queue = page.getByRole('region', { name: 'Live task queue' });
  await expect(queue).toContainText('FIXTURE · submitted queue');
  await expect(page.locator('[data-agent-id="codex-2"]')).toHaveAttribute('data-state', 'queued');
  await queue.getByRole('button', { name: /FIXTURE · submitted queue/ }).click();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  // A deep link wins over a previously selected task, including after reload.
  await page.evaluate(() => sessionStorage.setItem('ai-office-selected-task', 'deleted-task'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await navigate('Tasks');
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  // Deep links, direct hash changes and browser history must restore the correct workspace mode.
  const queuedTask = env.store.tasks().find((item) => item.state === 'queued');
  assert.ok(queuedTask);
  // Queue and history selections must open the exact task in a durable session
  // route, not only mutate an ephemeral selection (especially on mobile).
  await page
    .getByRole('region', { name: 'Submitted queue' })
    .getByRole('button', { name: /FIXTURE · submitted queue/ })
    .click();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  await navigate('Tasks');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('#task-history .task-row')
    .filter({ hasText: 'FIXTURE · submitted queue' })
    .click();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.locator('#task-workspace')).toBeFocused();
  await expect(page.locator('#task-workspace')).toBeInViewport();
  await page.reload();
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await page.goBack();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.locator('#task-history')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  await page.setViewportSize({ width: 1440, height: 1100 });
  // A valid task may have a stale review deep link before it has a workspace.
  // Offer its session instead of sending the user to unrelated task history.
  await page.evaluate((id) => {
    window.location.hash = `#task/${encodeURIComponent(id)}/review`;
  }, queuedTask.id);
  await expect(page.getByRole('alert')).toContainText('Code review is not available');
  await page.getByRole('button', { name: 'Open task session' }).click();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#task-workspace')).toContainText('FIXTURE · submitted queue');
  await page.evaluate((id) => {
    window.location.hash = `#task/${encodeURIComponent(id)}/session`;
  }, queuedTask.id);
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await page.evaluate(() => {
    window.location.hash = '#settings';
  });
  await expect(page.locator('.shell')).not.toHaveClass(/focus-mode/);
  await page.goBack();
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await page.goForward();
  await expect(page.locator('.shell')).not.toHaveClass(/focus-mode/);
  // Internal section navigation must create a browser history entry: the
  // previous destination should be recoverable without reloading the app.
  await navigate('Office');
  await capture('queued');
  await navigate('Tasks');
  await page.getByRole('button', { name: 'Cancel queued task' }).click();
  await manager.stop(env.store.tasks().find((task) => task.state === 'running')!.id);
  await newTask('codex-1', 'FIXTURE · saved completion', 'Review the README.');
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'completed',
    { timeout: 15000 },
  );
  await capture('completed');
  await newTask('codex-1', 'FIXTURE · provider failure', 'FAIL_FIXTURE');
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute('data-state', 'error', {
    timeout: 15000,
  });
  await capture('failure');
  // CSV export uses the current history filters and contains no prompt or transcript content.
  await navigate('Tasks');
  const history = page.locator('#task-history');
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
  await navigate('Office');

  // A temporary workflow API failure must not blank the Office or claim the
  // last known workflow snapshot is live. Polling recovers without reloading.
  await page.route('**/api/workflows', (route) => route.abort());
  await expect(page.getByText('Workflow status unavailable.', { exact: false })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator('.studio-agent').first()).toBeVisible();
  await page.unroute('**/api/workflows');
  await expect(page.getByText('Workflow status unavailable.', { exact: false })).toHaveCount(0, {
    timeout: 10000,
  });

  // Simulate transport failure while retaining genuine persisted application snapshots.
  await page.route('**/api/dashboard', (route) => route.abort());
  await expect(page.locator('.studio-notice').first()).toContainText('Connection interrupted', {
    timeout: 10000,
  });
  await expect(page.getByRole('button', { name: 'Assign a task', exact: true })).toBeDisabled();
  await capture('disconnected');
  await page.unroute('**/api/dashboard');
  await expect(page.locator('.studio-notice')).toHaveCount(0, { timeout: 10000 });
  assert.deepEqual(errors, []);
  console.log(
    `Office V4 browser passed: zero/two/six profiles, overflow selection, real SDK fixture reasoning, submitted queue exact-task selection, failure, disconnected snapshot, reduced motion and desktop/mobile overflow. Screenshots: ${artifacts}`,
  );
} finally {
  await browser.close();
  await app.close();
  await env.cleanup();
}
