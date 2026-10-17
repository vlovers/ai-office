import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.js';
import { TaskManager } from '../src/server/manager.js';
import { Workspaces } from '../src/server/workspaces.js';
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await sandbox();
const root = await realpath(env.root);
await writeFile(join(env.repository, 'deleted.txt'), 'delete me\n');
execFileSync('/usr/bin/git', ['-C', env.repository, 'add', '.']);
execFileSync('/usr/bin/git', [
  '-C',
  env.repository,
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'Fixture',
]);
const manager = new TaskManager(
  env.store,
  env.providers,
  env.auth,
  undefined,
  undefined,
  new Workspaces({
    authorizedRoot: root,
    workspaceRoot: join(root, 'worktrees'),
    commands: { fixture: ['/bin/echo', 'verification passed'] },
  }),
);
const app = await createApp(manager);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(address);
  await page.getByLabel('Absolute repository path').fill(env.repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Execution mode').selectOption('write');
  await page.getByLabel('Task title').fill('Implement isolated change');
  await page.getByLabel('What should the agent work on?').fill('WRITE_FIXTURE');
  await page.getByRole('button', { name: 'Create task' }).click();
  // Dismissing confirmation must leave the task unsubmitted.
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('queued');
  assert.equal(env.store.queue().length, 0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('completed');
  await page.getByRole('button', { name: 'Refresh Git review' }).click();
  const review = page.getByRole('region', { name: 'Isolated changes review' });
  await expect(review).toContainText('3 changed files');
  await expect(page.getByLabel('Git diff')).toContainText('+Modified by fixture');
  await expect(review).toContainText('ai-office/');
  await page.getByLabel('Git diff').focus();
  await expect(page.getByLabel('Git diff')).toBeFocused();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Verify: fixture' }).click();
  await expect(review).toContainText('fixture: Passed');
  await page.reload();
  await page.getByRole('button', { name: /Implement isolated change/ }).click();
  await page.getByRole('button', { name: 'Refresh Git review' }).click();
  await expect(review).toContainText('verification passed');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Review overflow at ${width}px`,
    );
  }
  await page.screenshot({
    path: join(process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir(), 'ai-office-v04-review.png'),
    fullPage: true,
  });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Reject and clean up…' }).click();
  await expect(review).toContainText('pending');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reject and clean up…' }).click();
  await expect(review).toContainText('rejected');
  assert.equal(await readFile(join(env.repository, 'README.md'), 'utf8'), '# Disposable example\n');
  assert.deepEqual(errors, []);
  console.log(
    'Write browser smoke passed: confirmation, Git review, verification persistence, keyboard diff focus, responsive widths, confirmed rejection and unchanged primary checkout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await env.cleanup();
}
