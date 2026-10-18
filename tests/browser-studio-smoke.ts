import { chromium, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { validateRepository } from '../src/server/repositories.js';
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const { TaskManager } = await import(pathToFileURL(resolve('dist/server/manager.js')).href);
const { Store } = await import(pathToFileURL(resolve('dist/server/store.js')).href);
const { CodexProvider } = await import(
  pathToFileURL(resolve('dist/server/providers/codex.js')).href
);
const { CodexAuth } = await import(
  pathToFileURL(resolve('dist/server/providers/codex-auth.js')).href
);
const env = await sandbox();
const auth = new CodexAuth({ dataDir: env.root, inspectLocal: async () => env.inspection });
await auth.refresh();
env.store.close();
let store: import('../src/server/store.js').Store = new Store(join(env.root, 'metadata.sqlite'));
const makeManager = () =>
  new TaskManager(store, env.providers, auth, undefined, undefined, undefined, {
    createProvider: (id: string) =>
      new CodexProvider({ home: join(env.root, 'workers', id), auth }),
    concurrency: 2,
  });
let manager = makeManager();
let app = await createApp(manager);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  store.register(await validateRepository(env.repository));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  // Complete repository registration after the task form was edited: its draft mode must survive.
  let releaseRegistration!: () => void;
  const registration = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  await page.route('**/api/repositories', async (route) => {
    const response = await route.fetch();
    await registration;
    await route.fulfill({ response });
  });
  await page.getByLabel('Absolute repository path').fill(env.repository);
  await page.getByRole('button', { name: /^Register/ }).click();
  await page.getByLabel('Execution mode').selectOption('write');
  releaseRegistration();
  await expect(page.getByRole('button', { name: /^Register/ })).toBeEnabled();
  await expect(page.getByLabel('Execution mode')).toHaveValue('write');
  await page.getByLabel('Execution mode').selectOption('read-only');
  const studio = page.getByRole('region', { name: 'Agent Studio', exact: true });
  await expect(studio).toBeVisible();
  const create = studio.getByRole('button', { name: 'Create agent' });
  await create.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create agent' });
  await expect(dialog.getByLabel('Agent name')).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Agent name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(create).toBeFocused();
  await create.click();
  await dialog.getByLabel('Agent name').fill('Review bot');
  await dialog.getByLabel('Role', { exact: true }).fill('Security reviewer');
  await dialog
    .getByLabel('Description', { exact: true })
    .fill('Synthetic profile for visual evidence');
  await dialog.getByLabel('Instructions', { exact: true }).fill('sk-syntheticcredential123456');
  await dialog.getByRole('button', { name: 'Save agent' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Remove credentials');
  assert.equal(store.agents().length, 2);
  await dialog
    .getByLabel('Instructions', { exact: true })
    .fill('<script>window.agentStudioInjected = true</script>');
  await expect(dialog.getByLabel('Maximum access preference')).toHaveValue('read-only');
  await dialog.getByRole('button', { name: 'Save agent' }).click();
  await expect(dialog).toHaveCount(0);
  const profile = store.agents().find((profile) => profile.name === 'Review bot')!;
  assert.ok(profile);
  const card = page.locator(`[data-profile-id="${profile.id}"]`);
  await expect(card).toContainText('v1');
  await card.getByRole('button', { name: 'Assign task', exact: true }).click();
  await expect(page.getByLabel('Assign to agent')).toHaveValue(profile.id);
  await page.getByLabel('Task title').fill('Studio review');
  await page.getByLabel('What should the agent work on?').fill('Review the README');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('completed', { timeout: 15000 });
  const first = store.tasks().find((task) => task.title === 'Studio review')!;
  const sessionId = first.sessionId!;
  await page.getByText('Pinned configuration · Review bot · v1', { exact: true }).click();
  await expect(page.locator('.configuration-record')).toContainText(
    '<script>window.agentStudioInjected = true</script>',
  );
  assert.equal(await page.evaluate(() => 'agentStudioInjected' in window), false);
  await card.getByRole('button', { name: 'Edit Review bot', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Review bot' });
  await edit.getByLabel('Instructions', { exact: true }).fill('Updated instructions');
  await edit.getByLabel('Model ID (optional)').fill('unavailable-model');
  await edit.getByRole('button', { name: 'Save agent' }).click();
  await expect(card).toContainText('v2');
  await expect(page.locator('.configuration-record')).toContainText('Current profile v2');
  await page.getByLabel('Task title').fill('Studio resume');
  await page.getByLabel('What should the agent work on?').fill('Continue the review');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByLabel('Session', { exact: true }).selectOption(sessionId);
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('completed', { timeout: 15000 });
  assert.equal(store.tasks().find((task) => task.title === 'Studio resume')?.sessionId, sessionId);
  await expect(page.locator('.configuration-record')).toContainText('v1');
  await card.getByRole('button', { name: 'Duplicate Review bot', exact: true }).click();
  await expect(studio.locator('.profile-card')).toHaveCount(4);
  await card.getByRole('button', { name: 'Archive Review bot', exact: true }).click();
  await expect(card).toHaveCount(0);
  await studio.getByLabel('Show archived profiles').check();
  await expect(card).toContainText('archived');
  await card.getByRole('button', { name: 'Restore Review bot', exact: true }).click();
  await expect(card).not.toContainText('archived');
  const screenshotDir = process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir();
  await studio.screenshot({ path: join(screenshotDir, 'ai-office-agent-studio-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await card.getByRole('button', { name: 'Edit Review bot', exact: true }).click();
  await expect(edit).toBeVisible();
  assert.ok(await edit.evaluate((el) => el.getBoundingClientRect().width < innerWidth));
  await page.screenshot({ path: join(screenshotDir, 'ai-office-agent-studio-mobile.png') });
  await page.keyboard.press('Escape');
  await app.close();
  store.close();
  store = new Store(join(env.root, 'metadata.sqlite'));
  manager = makeManager();
  app = await createApp(manager);
  const restarted = await app.listen({ host: '127.0.0.1', port: 0 });
  await page.goto(restarted);
  await expect(studio).toContainText('Review bot');
  assert.equal(store.requireAgent(profile.id).revision, 4);
  assert.equal(store.taskConfiguration(first.id)?.profileRevision, 1);
  assert.equal(store.sessions().length, 1);
  await page.getByRole('button', { name: /Studio review/ }).click();
  await expect(page.locator('.configuration-record')).toContainText('v1');
  assert.deepEqual(errors, []);
  console.log(
    'PASS Agent Studio: keyboard dialog/focus, strict defaults, CRUD, dynamic task, safe text, pinned resume, responsive UI and database restart. No inference.',
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
  await env.cleanup();
}
