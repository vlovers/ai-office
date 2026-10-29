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
  await page.getByRole('heading', { name: 'Office overview_' }).waitFor();
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
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Office' })
    .click();
  await page.getByRole('link', { name: 'Skip to mission control' }).focus();
  await expect(page.getByRole('link', { name: 'Skip to mission control' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
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
  await expect(page.locator('#agent')).toContainText('Codex 02');
  await expect(page.locator('.studio-agent').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.studio-agent').first().click();
  await expect(firstDesk).toHaveAttribute('aria-pressed', 'true');
  await secondDesk.focus();
  await page.keyboard.press('Enter');
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
  await expect(firstDesk).toBeFocused();
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).click();
  await expect(page.locator('#agent')).toBeFocused();
  assert.equal(env.store.tasks().length, 0, 'Workstation invented a task');
  await page.getByRole('link', { name: 'Register local worktree' }).click();
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
  await page.getByLabel('Task title').fill('Review the example project');
  await page.getByLabel('What should the agent work on?').fill('Review the README.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.locator('.task-toolbar .badge').filter({ hasText: 'completed' }).waitFor();
  await page.getByRole('heading', { name: 'Final result' }).waitFor();
  await expect(page.locator('[data-agent-id="codex-1"]')).toHaveAttribute(
    'data-state',
    'completed',
  );
  assert.match(await page.locator('.result').innerText(), /Reviewed the disposable repository/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(screenshotDir, 'ai-office-phosphor-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await expect(page.locator('.result')).toContainText('Reviewed the disposable repository');
  await page.getByRole('button', { name: 'Office overview', exact: true }).click();
  await page.reload();
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
  await expect(page.locator('#task-workspace')).toContainText('Stop review');
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Focus Mode', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('#task-workspace')).toBeFocused();
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
  await expect(page.getByRole('button', { name: 'Focus Mode', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('nav a[href="#agent"]').click();
  await expect(page.locator('#agent')).toBeVisible();
  await expect(page.locator('.office-workstation').first()).toHaveAttribute('data-state', 'idle');
  await createTask('Failed review', 'FAIL_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('failed');
  await expect(page.locator('.task-error')).toContainText('Provider diagnostics were withheld');
  await expect(page.locator('.task-error')).not.toContainText('Simulated provider failure');
  await expect(page.locator('.office-workstation').first()).toHaveAttribute('data-state', 'error');
  // Launch both real agent slots against two disposable worktrees through the UI.
  await page.getByLabel('Assign to agent').selectOption('codex-1');
  await createTask('Agent A concurrent', 'WAIT_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  const taskA = env.store.tasks().find((task) => task.title === 'Agent A concurrent')!;
  await page.getByLabel('Absolute repository path').fill(secondEnv.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Assign to agent').selectOption('codex-2');
  await createTask('Agent B concurrent', 'WAIT_FIXTURE');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  const taskB = env.store.tasks().find((task) => task.title === 'Agent B concurrent')!;
  // Reload resets history disclosure. Reopen it before checking persisted activity.
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
  await createTask('Agent B queue', 'Review later');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByRole('region', { name: 'Submitted queue' })).toContainText(
    'Agent B queue',
  );
  await page.getByRole('button', { name: 'Cancel queued task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('stopped');
  await page.getByRole('button', { name: 'Select Codex 01 workstation' }).click();
  await expect(page.locator('#task-workspace')).toContainText('Agent A concurrent');
  await page.getByRole('button', { name: /Stop agent/ }).click();
  // B's Stop remains usable while A waits for its own process-group cleanup.
  await page.getByRole('button', { name: 'Office overview', exact: true }).click();
  await page.getByRole('button', { name: 'Select Codex 02 workstation' }).click();
  await expect(page.getByRole('button', { name: /Stop agent/ })).toBeEnabled();
  await expect.poll(() => env.store.task(taskA.id)?.state).toBe('stopped');
  assert.equal(env.store.task(taskB.id)?.state, 'running', 'Stopping A affected B');
  await page.getByRole('button', { name: 'Office overview', exact: true }).click();
  await page.getByRole('button', { name: 'Select Codex 02 workstation' }).click();
  await expect(page.locator('#task-workspace')).toContainText('Agent B concurrent');
  await expect(page.getByRole('log')).toContainText('Waiting for Stop');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Office overview', exact: true }).click();
  await page.screenshot({ path: join(screenshotDir, 'ai-office-v03-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshotDir, 'ai-office-v03-mobile.png'), fullPage: true });
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
