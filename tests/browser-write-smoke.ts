import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.js';
import { TaskManager } from '../src/server/manager.js';
import { Store } from '../src/server/store.js';
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
let store = env.store;
const service = new Workspaces({
  authorizedRoot: root,
  workspaceRoot: join(root, 'worktrees'),
  commands: { fixture: ['/bin/echo', 'verification passed'] },
  allowHostVerification: true,
});
let manager = new TaskManager(env.store, env.providers, env.auth, undefined, undefined, service);
let app = await createApp(manager);

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
  await page.getByRole('link', { name: 'Code Review Center ↗' }).click();
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
  // Real production UI over HTTP and SDK transport; no model calls.
  await expect(review).toHaveAttribute('aria-busy', 'false');
  const files = review.getByRole('group', { name: 'File selection' });
  await files.getByRole('button').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(files.getByRole('button').nth(1)).toBeFocused();
  await expect(files.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Filter files').fill('README');
  await expect(files.getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Comment on new line 1', exact: true }).click();
  await expect(page.getByLabel('Review comment', { exact: true })).toBeFocused();
  await page
    .getByLabel('Review comment', { exact: true })
    .fill('CORRECT_FIXTURE: clarify the README');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft feedback' }).click();
  await expect(review).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Request Changes…' })).toBeEnabled();
  await page.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await page
    .getByLabel('Review comment', { exact: true })
    .fill('CORRECT_FIXTURE: clarify README and retain context');
  await page.getByRole('button', { name: 'Update comment' }).click();
  await page.getByRole('button', { name: 'Save draft feedback' }).click();
  await expect(review).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Comment scope').selectOption('general');
  await page.getByLabel('Review comment', { exact: true }).fill('Temporary comment');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await review
    .locator('.review-comments li')
    .last()
    .getByRole('button', { name: 'Remove comment' })
    .click();
  await page.getByRole('button', { name: 'Save draft feedback' }).click();
  await expect(review).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await page.getByRole('button', { name: /Implement isolated change/ }).click();
  await expect(review).toContainText('CORRECT_FIXTURE: clarify README and retain context');
  await review.screenshot({
    path: join(process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir(), 'ai-office-v05-feedback.png'),
  });
  await page.getByRole('button', { name: 'Request Changes…' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm Codex continuation' });
  await expect(confirmation).toContainText('CORRECT_FIXTURE: clarify README and retain context');
  await expect(confirmation).toContainText('ai-office/');
  await expect(confirmation.getByRole('button', { name: 'Cancel continuation' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Request Changes…' })).toBeFocused();
  assert.equal(store.tasks().length, 1);
  await page.getByRole('button', { name: 'Request Changes…' }).click();
  await confirmation.getByRole('button', { name: 'Confirm Request Changes' }).click();
  await expect(review).toContainText('Review revision 2', { timeout: 15000 });
  assert.equal(store.tasks().length, 2);
  await page.getByLabel('Filter files').fill('README');
  await expect(page.getByLabel('Git diff')).toContainText('+Corrected by fixture');
  const oldRevision = store.reviewRecords(store.tasks()[0]!.workspaceId!)[1]!.revision;
  await page.getByLabel('Review history').selectOption(oldRevision);
  await expect(review).toContainText('HISTORICAL PATCH');
  await expect(review).toContainText('outdated outside this revision');
  await expect(page.getByLabel('Git diff')).toContainText('+Modified by fixture');
  await expect(page.getByRole('button', { name: 'Keep isolated changes' })).toHaveCount(0);
  await page.getByLabel('Review history').selectOption('');
  await page
    .getByLabel('Review comment', { exact: true })
    .fill('FAIL_FIXTURE: simulate resume failure');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft feedback' }).click();
  await expect(review).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Request Changes…' }).click();
  await confirmation.getByRole('button', { name: 'Confirm Request Changes' }).click();
  await expect(review).toContainText('Review revision 3', { timeout: 15000 });
  await page.getByText('Iteration outcomes and verification', { exact: true }).click();
  await expect(review).toContainText('failed');
  await expect(review).toContainText('Codex task failed. Provider diagnostics were withheld');
  // A full backend/SQLite restart retains patches, comments, outcomes and workspace ownership.
  await app.close();
  store.close();
  store = new Store(join(env.root, 'metadata.sqlite'));
  manager = new TaskManager(store, env.providers, env.auth, undefined, undefined, service);
  app = await createApp(manager);
  const restartedAddress = await app.listen({ host: '127.0.0.1', port: 0 });
  await page.goto(restartedAddress);
  await page.getByRole('button', { name: /^Implement isolated change/ }).click();
  await expect(review).toContainText('Review revision 3');
  await page.getByLabel('Review history').selectOption(oldRevision);
  await expect(review).toContainText('CORRECT_FIXTURE: clarify README and retain context');
  await page.getByLabel('Review history').selectOption('');
  await page.getByLabel('Filter files').fill('README');
  await expect(page.getByLabel('Git diff')).toContainText('Corrected by fixture');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Review overflow at ${width}px`,
    );
    if (width === 390)
      await review.screenshot({
        path: join(process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir(), 'ai-office-v05-mobile.png'),
      });
  }
  await page.screenshot({
    path: join(process.env.AI_OFFICE_SCREENSHOT_DIR ?? tmpdir(), 'ai-office-v05-review.png'),
    fullPage: true,
  });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Reject and clean up…' }).click();
  await expect(review).toContainText('pending');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reject and clean up…' }).click();
  await expect(review).toContainText('rejected');
  assert.equal(await readFile(join(env.repository, 'README.md'), 'utf8'), '# Disposable example\n');
  await page.getByLabel('Review history').selectOption(oldRevision);
  await expect(review).toContainText('CORRECT_FIXTURE: clarify README and retain context');
  // Keep after a separate corrected proposal exercises the other terminal decision.
  await page.getByLabel('Execution mode').selectOption('write');
  await page.getByLabel('Task title').fill('Keep corrected proposal');
  await page.getByLabel('What should the agent work on?').fill('WRITE_FIXTURE');
  await page.getByRole('button', { name: 'Create task' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.locator('.task-toolbar .badge')).toHaveText('completed');
  await expect(review).toContainText('Review revision 1');
  await page
    .getByLabel('Review comment', { exact: true })
    .fill('CORRECT_FIXTURE: prepare for Keep');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft feedback' }).click();
  await expect(review).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Request Changes…' }).click();
  await confirmation.getByRole('button', { name: 'Confirm Request Changes' }).click();
  await expect(review).toContainText('Review revision 2', { timeout: 15000 });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Keep isolated changes' }).click();
  await expect(review).toContainText('kept');
  const kept = store.workspaces().find((workspace) => workspace.decision === 'kept')!;
  assert.equal(await readFile(join(kept.path, 'README.md'), 'utf8'), 'Corrected by fixture\n');
  assert.equal(await readFile(join(env.repository, 'README.md'), 'utf8'), '# Disposable example\n');
  assert.deepEqual(errors, []);
  console.log(
    'Review Center browser passed: keyboard file/line navigation, draft edit/remove/reload, cancel and confirmed exact feedback, SDK resume, new revisions, outdated history, resume failure, backend restart, verification attribution, responsive widths and confirmed Keep/Reject with preserved history and unchanged primary checkout.',
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
  await env.cleanup();
}
