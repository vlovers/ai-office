import { chromium, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.js';
import assert from 'node:assert/strict';

// Run after npm run build. Production Fastify serves the compiled React application.
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await sandbox();
const secondEnv = await sandbox();
const app = await createApp(env.manager);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  const screenshotDir = process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir();
  await page.getByRole('heading', { name: /^Office overview/ }).waitFor();
  await expect(page.getByRole('region', { name: 'Get started' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Focus Mode', exact: true })).toBeDisabled();
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-phosphor-onboarding.png'),
    fullPage: true,
  });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('codex-connection-status').filter({ hasText: 'Available' }).waitFor();
  // On narrow screens the active destination stays visible in the scrollable
  // navigation strip, including after resizing an already open deep link.
  await page.setViewportSize({ width: 320, height: 700 });
  const mobileNavigation = page.getByRole('navigation', { name: 'Main navigation' });
  const activeMobileDestinationVisible = () =>
    mobileNavigation.evaluate((element) => {
      const active = element.querySelector('[aria-current="page"]');
      if (!active) return false;
      const navBounds = element.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      return activeBounds.left >= navBounds.left - 1 && activeBounds.right <= navBounds.right + 1;
    });
  await expect.poll(activeMobileDestinationVisible).toBe(true);
  // A direct deep link loaded at 320px must reveal Settings without scrolling
  // the document or requiring a click on the navigation strip.
  await page.reload();
  await expect(page).toHaveURL(/#settings$/);
  await expect(mobileNavigation.getByRole('button', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect.poll(activeMobileDestinationVisible).toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  // The keyboard skip link must not navigate away from Settings.
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await expect(page).toHaveURL(/#settings$/);
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', {
      name: 'Settings',
    }),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  // The legacy pixel scene is opt-in; expand it to retain the existing
  // motion, workstation and accessibility regression coverage.
  const officeVisual = page.locator('.office-visual');
  await expect(officeVisual).not.toHaveAttribute('open', '');
  await officeVisual.locator('summary').click();
  await expect(officeVisual).toHaveAttribute('open', '');
  const crt = page.getByRole('button', { name: /CRT effects:/ });
  await expect(crt).toHaveAttribute('aria-pressed', 'false');
  await crt.focus();
  await page.keyboard.press('Enter');
  await expect(crt).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(crt).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page.locator('.shell').evaluate((el) => getComputedStyle(el, '::after').display),
    'none',
  );
  assert.equal(
    await page
      .locator('.character-body')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  const motion = page.getByRole('button', { name: /Scene motion:/ });
  await motion.click();
  await page.reload();
  await expect(motion).toHaveAttribute('aria-pressed', 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(
    await page
      .locator('.character-body')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await motion.click();
  await expect(motion).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.office-workstation').first()).toHaveAttribute('data-state', 'idle');
  await expect
    .poll(() =>
      page
        .locator('.character-body')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    )
    .toBe('idle-breathe');
  await expect(page.locator('.office-scene')).toHaveCount(1);
  await expect(page.locator('svg.pixel-office')).toHaveCount(1);
  await expect(page.locator('.office-workstation')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Office floor operations' })).toBeVisible();
  await expect(page.locator('.studio-agent')).toHaveCount(2);
  await expect(page.locator('.studio-agent[aria-pressed="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.locator('.studio-agent')).toHaveCount(0);
  await expect(page.getByText('No agents match this filter.')).toBeVisible();
  await page.getByRole('button', { name: 'Queued', exact: true }).click();
  await expect(page.locator('.studio-agent')).toHaveCount(0);
  await page.getByRole('button', { name: 'All agents', exact: true }).click();
  await expect(page.locator('.studio-agent')).toHaveCount(2);
  await expect(page.locator('.isometric-office')).toHaveCount(1);
  await expect(page.locator('.office-environment')).toHaveCount(1);
  await expect(page.locator('.iso-station')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Selected agent inspector' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live task queue' })).toContainText(
    'No queued tasks.',
  );
  await page.getByRole('button', { name: /Recent task activity/ }).click();
  await expect(page.getByRole('region', { name: 'Recent agent tasks' })).toContainText(
    'No recorded tasks.',
  );
  const firstDesk = page.getByRole('button', { name: 'Select Codex 01 workstation' });
  const secondDesk = page.getByRole('button', { name: 'Select Codex 02 workstation' });
  await firstDesk.focus();
  await page.keyboard.press('ArrowRight');
  await expect(secondDesk).toBeFocused();
  await page.keyboard.press(' ');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(secondDesk).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Agents' })
    .click();
  await expect(page.locator('#agent')).toContainText('Codex 02');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('.studio-agent').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.studio-agent').first().click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(firstDesk).toHaveAttribute('aria-pressed', 'true');
  await secondDesk.focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(secondDesk).toHaveAttribute('aria-pressed', 'true');
  await firstDesk.focus();
  await page.keyboard.press('Home');
  await expect(firstDesk).toBeFocused();
  // Force activation and subsequent focus movement within one frame: deferred navigation
  // must not override a newer keyboard action, even on a slower CI renderer.
  await page.evaluate(async () => {
    const first = document.querySelector<SVGGElement>('[data-agent-id="codex-1"]')!;
    const second = document.querySelector<SVGGElement>('[data-agent-id="codex-2"]')!;
    second.focus();
    second.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    first.focus();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await firstDesk.focus();
  await expect(firstDesk).toBeFocused();
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).click();
  await expect(firstDesk).toBeFocused();
  await expect(firstDesk).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.shell')).toHaveAttribute('data-page', 'office');
  assert.equal(env.store.tasks().length, 0, 'Workstation invented a task');
  await page.getByRole('link', { name: 'Register local worktree' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByLabel('Absolute repository path').focus();
  await expect(page.getByLabel('Absolute repository path')).toBeFocused();
  await crt.click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByLabel('Authentication mode').selectOption('api-key');
  await page
    .getByTestId('codex-connection-status')
    .filter({ hasText: 'Authentication required' })
    .waitFor();
  await page.getByLabel('Authentication mode').selectOption('local-cli-chatgpt');
  await page.getByTestId('codex-connection-status').filter({ hasText: 'Available' }).waitFor();
  await page.getByLabel('Absolute repository path').fill(env.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('region', { name: 'Get started' })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.getByLabel('Task title').fill('Review the example project');
  await page.getByLabel('What should the agent work on?').fill('Review the README.');
  await page.getByRole('button', { name: 'Create task' }).click();
  // Creating a task must leave the composer route and give the new session a
  // durable address, including after a full reload on a narrow screen.
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await expect(page.getByRole('heading', { name: 'Task session_' })).toBeVisible();
  await expect(page.locator('#task-workspace')).toContainText('Review the example project');
  // Focus mode intentionally hides task history. Return to the Tasks list
  // to exercise its mobile filters, then restore the task-scoped deep link.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await expect(page.locator('.shell')).not.toHaveClass(/focus-mode/);
  // On a phone the task history filters start collapsed so the selected task
  // remains reachable. Expanding, collapsing and resizing must preserve inputs.
  const historyFilters = page.locator('#task-history-filters');
  const filterToggle = page.getByRole('button', { name: /^Filters/ });
  await expect(filterToggle).toBeVisible();
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(historyFilters).toBeHidden();
  await filterToggle.click();
  await expect(historyFilters).toBeVisible();
  await page.getByLabel('Search tasks').fill('Review the example');
  await expect(filterToggle).toContainText('1 active');
  await filterToggle.click();
  await expect(historyFilters).toBeHidden();
  await filterToggle.click();
  await expect(page.getByLabel('Search tasks')).toHaveValue('Review the example');
  await page.getByRole('button', { name: 'Reset task filters' }).click();
  await expect(filterToggle).toHaveText('Filters');
  await filterToggle.click();
  await expect(historyFilters).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(historyFilters).toBeVisible();
  await expect(filterToggle).toBeHidden();
  await page.goBack();
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await expect(page.getByRole('button', { name: 'Start task' })).toBeVisible();
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.locator('.task-toolbar .badge').filter({ hasText: 'completed' }).waitFor();
  await page.getByRole('heading', { name: 'Final result' }).waitFor();
  assert.match(await page.locator('.result').innerText(), /Reviewed the disposable repository/);
  // Simulate terminal SSE (HTTP 204). Retry must restore only live reading,
  // without a task submission, a queue mutation, or a full reload.
  const closedStreamPattern = /\/api\/tasks\/[^/]+\/stream(?:\?.*)?$/;
  await page.route(closedStreamPattern, async (route) => {
    await route.fulfill({ status: 204 });
  });
  await page.reload();
  await expect(page.locator('.connection')).toContainText('Live event stream disconnected');
  const retryStream = page.getByRole('button', { name: 'Retry live events' });
  await expect(retryStream).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  assert.ok((await retryStream.boundingBox())!.height >= 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const retryTask = env.store.tasks().find((item) => item.title === 'Review the example project');
  assert.ok(retryTask);
  const stateBeforeRetry = retryTask.state;
  const queuedBeforeRetry = env.store.queue().length;
  await page.unroute(closedStreamPattern);
  await retryStream.click();
  await expect(page.locator('.connection')).toContainText('Live events connected');
  await expect(retryStream).toHaveCount(0);
  assert.equal(env.store.tasks().find((item) => item.id === retryTask.id)?.state, stateBeforeRetry);
  assert.equal(env.store.queue().length, queuedBeforeRetry);
  // A reader scrolling back through a long log must not be dragged to the
  // latest event. The explicit recovery control must also work on mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  const log = page.getByRole('log', { name: 'Agent event log' });
  await expect(log.locator('.event-line').first()).toBeVisible();
  // Explicit pause is available to keyboard users without first scrolling.
  // A persisted SSE event must update the unread count without resuming follow.
  const taskForLog = env.store.tasks().find((item) => item.title === 'Review the example project');
  assert.ok(taskForLog);
  const recoveredEvent = env.store.addEvent(taskForLog.id, 'progress', 'Fixture after SSE retry');
  env.manager.events.emit('event', recoveredEvent);
  await expect(log).toContainText('Fixture after SSE retry');
  await expect(log).toHaveAttribute('aria-live', 'polite');
  await page.getByRole('button', { name: 'Pause auto-scroll' }).click();
  await expect(log).toHaveAttribute('aria-live', 'off');
  const firstUnread = env.store.addEvent(taskForLog.id, 'progress', 'Fixture unread event one');
  env.manager.events.emit('event', firstUnread);
  await expect(log).toContainText('Fixture unread event one');
  await expect(page.locator('.event-console-toolbar')).toContainText('1 new');
  await expect(page.getByRole('button', { name: 'Jump to latest event' })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest event' }).click();
  await expect(log).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByRole('button', { name: 'Pause auto-scroll' })).toBeVisible();
  await expect(page.locator('.event-console-toolbar')).not.toContainText('new');

  await log.evaluate((element) => {
    const first = element.querySelector<HTMLElement>('.event-line')!;
    first.style.minHeight = '1200px';
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Jump to latest event' })).toBeVisible();
  const scrolledBack = await log.evaluate((element) => element.scrollTop);
  const secondUnread = env.store.addEvent(taskForLog.id, 'progress', 'Fixture unread event two');
  env.manager.events.emit('event', secondUnread);
  await expect(log).toContainText('Fixture unread event two');
  await expect(page.locator('.event-console-toolbar')).toContainText('1 new');
  assert.equal(await log.evaluate((element) => element.scrollTop), scrolledBack);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Jump to latest event' }).click();
  await expect
    .poll(() =>
      log.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 48,
      ),
    )
    .toBe(true);
  await log.evaluate((element) => {
    element.querySelector<HTMLElement>('.event-line')!.style.minHeight = '';
  });
  // The narrowest supported phone must keep both live-log actions reachable
  // and large enough for touch, including while the reader has paused output.
  await page.setViewportSize({ width: 320, height: 720 });
  const pauseButton = page.getByRole('button', { name: 'Pause auto-scroll' });
  await expect(pauseButton).toBeVisible();
  assert.ok((await pauseButton.boundingBox())!.height >= 44);
  await pauseButton.click();
  const resumeButton = page.getByRole('button', { name: 'Jump to latest event' });
  await expect(resumeButton).toBeVisible();
  assert.ok((await resumeButton.boundingBox())!.height >= 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await resumeButton.click();
  await expect(log).toHaveAttribute('aria-live', 'polite');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'completed',
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-phosphor-desktop.png'),
    fullPage: true,
  });
  await expect(page.locator('.result')).toContainText('Reviewed the disposable repository');
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await page.locator('.task-row').filter({ hasText: 'Review the example project' }).click();
  await page.getByRole('heading', { name: 'Final result' }).waitFor();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Overflow at ${width}px`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-phosphor-mobile.png'),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'Mobile page overflows horizontally',
  );
  // Exercise persisted session selection and cancellation through the redesigned UI.
  const createTask = async (title: string, prompt: string) => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Tasks' })
      .click();
    await page.getByRole('button', { name: '+ New task' }).click();
    await page.getByLabel('Task title').fill(title);
    await page.getByLabel('What should the agent work on?').fill(prompt);
    await page.getByRole('button', { name: 'Create task' }).click();
    await expect(page.locator('.task-toolbar .badge')).toHaveText('queued');
  };
  await createTask('Resume review', 'Continue the saved review.');
  await page.getByLabel('Session', { exact: true }).selectOption(env.store.sessions()[0]!.id);
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('completed');
  await expect(page.locator('.result')).toContainText('Resumed the saved review thread.');
  assert.equal(env.store.sessions().length, 1, 'Resume created an extra session');
  await createTask('Stop review', 'WAIT_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('.office-workstation').first()).toHaveAttribute(
    'data-state',
    'thinking',
  );
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Office overview', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await expect(page.locator('#task-workspace')).toContainText('Stop review');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await expect(page.locator('#task-workspace')).toBeFocused();
  // Leaving Focus Mode through the overview control must update the URL.
  // Back restores the same task-scoped session instead of a stale mission view.
  await page.getByRole('button', { name: 'Office overview', exact: true }).click();
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.locator('.shell')).toHaveAttribute('data-page', 'office');
  await expect(page.locator('.shell')).not.toHaveClass(/focus-mode/);
  await page.goBack();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await expect(page.locator('#task-workspace')).toBeFocused();
  // Skipping to main content from a task link must preserve its deep link.
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await expect(page).toHaveURL(/#task\/[^/]+\/session$/);
  await expect(page.locator('.office-scene').first()).toBeHidden();
  await expect(page.locator('#compose')).toBeHidden();
  await expect(page.getByRole('button', { name: /Stop agent/ })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-phosphor-focus-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('complementary', { name: 'Agent and connection inspector' }),
  ).toBeHidden();
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-phosphor-focus-mobile.png'),
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.getByRole('button', { name: /Stop agent/ }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('stopped');
  await expect(page.locator('.shell')).toHaveClass(/focus-mode/);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Agents' })
    .click();
  await expect(page.locator('#agent')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('.office-workstation').first()).toHaveAttribute('data-state', 'idle');
  await createTask('Failed review', 'FAIL_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('failed');
  await expect(page.locator('.task-error')).toContainText('Provider diagnostics were withheld');
  await expect(page.locator('.task-error')).not.toContainText('Simulated provider failure');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('.office-workstation').first()).toHaveAttribute('data-state', 'error');
  // Launch both real agent slots against two disposable worktrees through the UI.
  await createTask('Agent A concurrent', 'WAIT_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  const taskA = env.store.tasks().find((task) => task.title === 'Agent A concurrent')!;
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByLabel('Absolute repository path').fill(secondEnv.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.getByLabel('Assign to agent').selectOption('codex-2');
  await createTask('Agent B concurrent', 'WAIT_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  const taskB = env.store.tasks().find((task) => task.title === 'Agent B concurrent')!;
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  // Recent agent activity and the selected-agent inspector belong to the Office page.
  const history = page.getByRole('button', { name: /Recent task activity/ });
  if ((await history.getAttribute('aria-expanded')) === 'false') await history.click();
  await expect(page.getByRole('region', { name: 'Recent agent tasks' })).toContainText(
    'Agent A concurrent',
  );
  await expect(page.getByRole('region', { name: 'Recent agent tasks' })).toContainText(
    'Agent B concurrent',
  );
  await expect(page.getByRole('region', { name: 'Selected agent inspector' })).toContainText(
    'Agent B concurrent',
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await expect(page.locator('.office-workstation').nth(0)).toHaveAttribute(
    'data-state',
    'thinking',
  );
  await expect(page.locator('.office-workstation').nth(1)).toHaveAttribute(
    'data-state',
    'thinking',
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-shared-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.shared-office')).toHaveAttribute('data-layout', 'portrait');
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-shared-mobile.png'),
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  assert.equal(env.store.task(taskA.id)?.state, 'running');
  assert.equal(env.store.task(taskB.id)?.state, 'running');
  // A queued task is visible/cancellable without interrupting B's active task.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.getByLabel('Assign to agent').selectOption('codex-2');
  await createTask('Agent B queue', 'Review later');
  await page.getByRole('button', { name: 'Start task' }).click();
  const queuedTask = env.store.tasks().find((task) => task.title === 'Agent B queue')!;
  // Submitting a task opens its own session instead of the legacy queue panel.
  await expect(page).toHaveURL(new RegExp('#task/' + queuedTask.id + '/session$'));
  await expect(page.locator('#task-workspace')).toContainText('Agent B queue');
  await expect(page.locator('#task-workspace').getByRole('status')).toContainText(
    'Waiting for assigned agent.',
  );
  await page.getByRole('button', { name: 'Cancel queued task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('stopped');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).click();
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await expect(page.locator('#task-workspace')).toContainText('Agent A concurrent');
  await page.getByRole('button', { name: /Stop agent/ }).click();
  // B's Stop remains usable while A waits for its own process-group cleanup.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await page.getByRole('button', { name: 'Select Codex 02 workstation' }).click();
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await expect(page.getByRole('button', { name: /Stop agent/ })).toBeEnabled();
  await expect.poll(() => env.store.task(taskA.id)?.state).toBe('stopped');
  assert.equal(env.store.task(taskB.id)?.state, 'running', 'Stopping A affected B');
  await expect(page.locator('#task-workspace')).toContainText('Agent B concurrent');
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await page.screenshot({ path: join(screenshotDir, 'ai-office-v03-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshotDir, 'ai-office-v03-mobile.png'), fullPage: true });
  await expect(page.locator('#task-workspace')).toContainText('Agent B concurrent');
  await page.getByRole('button', { name: /Stop agent/ }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('stopped');
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: two agents/worktrees; parallel SSE; queue cancellation; Stop A/B isolation; onboarding; real workstation selection; focus/overview; thinking/error states; motion preference; keyboard navigation; CRT preference/reduced motion; auth modes; register → start → SSE result → persisted resume → stop → failure; responsive 320–1440px; no page errors.',
  );
} finally {
  // Close the HTTP server while the browser still has keep-alive/SSE connections.
  const closing = app.close();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closing,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('HTTP shutdown did not close browser connections.')),
          3000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close();
    await closing;
    await env.cleanup();
    await secondEnv.cleanup();
  }
}
