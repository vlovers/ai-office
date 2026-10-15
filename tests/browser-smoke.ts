import { chromium } from '@playwright/test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.js';
import assert from 'node:assert/strict';

// Run after npm run build. Production Fastify serves the compiled React application.
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await sandbox();
const app = await createApp(env.manager);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await page.getByRole('heading', { name: 'Your agent workspace.' }).waitFor();
  await page.getByTestId('codex-connection-status').filter({ hasText: 'Available' }).waitFor();
  await page.getByLabel('Authentication mode').selectOption('api-key');
  await page
    .getByTestId('codex-connection-status')
    .filter({ hasText: 'Authentication required' })
    .waitFor();
  await page.getByLabel('Authentication mode').selectOption('local-cli-chatgpt');
  await page.getByTestId('codex-connection-status').filter({ hasText: 'Available' }).waitFor();
  await page.getByLabel('Absolute repository path').fill(env.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Task title').fill('Review the example project');
  await page.getByLabel('What should the agent work on?').fill('Review the README.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.locator('.task-toolbar .badge').filter({ hasText: 'completed' }).waitFor();
  await page.getByRole('heading', { name: 'Final result' }).waitFor();
  assert.match(await page.locator('.result').innerText(), /Reviewed the disposable repository/);
  await page.evaluate(() => window.scrollTo(0, 0));
  const screenshotDir = process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir();
  await page.screenshot({ path: join(screenshotDir, 'ai-office-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /Review the example project/ }).click();
  await page.getByRole('heading', { name: 'Final result' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshotDir, 'ai-office-mobile.png'), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'Mobile page overflows horizontally',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: register → create → start → SSE result → reload history; desktop and mobile layouts; no page errors.',
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
  }
}
