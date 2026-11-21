import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateRepository } from '../src/server/repositories.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { workflowFixture } from './workflow-fixture.js';
import { OrchestrationStore } from '../src/server/orchestration.js';
const { createApp } = await import(pathToFileURL(resolve('dist/server/app.js')).href);
const env = await workflowFixture({ appFactory: createApp });
const artifacts =
  process.env.AI_OFFICE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'ai-office-v09-orchestration');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const address = await env.app.listen({ host: '127.0.0.1', port: 0 });
  // Real HTTP/SQLite/native sandbox + deterministic Codex SDK fixture; no inference/credentials.
  await page.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      const banner = document.createElement('p');
      banner.textContent =
        'TEST FIXTURE · persisted operator proposals · native sandbox · no model calls';
      document.body.prepend(banner);
    }),
  );
  await page.goto(address + '/orchestration.html');
  const module = page.getByRole('region', { name: 'Project orchestration', exact: true });
  await expect(module.getByRole('button', { name: 'Generate plan — unavailable' })).toBeDisabled();
  await page
    .getByRole('navigation', { name: 'Project modules' })
    .getByRole('button', { name: 'Project Context', exact: true })
    .click();
  await module.getByRole('button', { name: 'Edit context', exact: true }).click();
  await module
    .getByLabel('Brief', { exact: true })
    .fill('Disposable fixture: verify source changes without any remote writes.');
  await module
    .getByLabel('Constraints', { exact: true })
    .fill('No push, merge or deployment. All approvals are explicit.');
  await module.getByRole('button', { name: 'Save context', exact: true }).click();
  await expect(module.getByText('Operator supplied · revision 1', { exact: false })).toBeVisible();
  const capture = async (name: string) => {
    for (const width of [1440, 1920, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({ path: join(artifacts, `${name}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  await capture('context');
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Project modules' })
    .getByRole('button', { name: 'Project Context', exact: true })
    .click();
  await expect(module.getByLabel('Brief', { exact: true })).toHaveValue(
    'Disposable fixture: verify source changes without any remote writes.',
  );
  await page
    .getByRole('navigation', { name: 'Project modules' })
    .getByRole('button', { name: 'Lead Agent', exact: true })
    .click();
  await module.getByLabel('Plan title', { exact: true }).fill('Native workflow fixture proposal');
  await module.getByLabel('Objective', { exact: true }).fill('WRITE_FIXTURE');
  await module.getByLabel('coder agent', { exact: true }).selectOption('codex-1');
  await module.getByLabel('reviewer agent', { exact: true }).selectOption('codex-2');
  await module.getByLabel('Include sandboxed QA', { exact: false }).check();
  await module.getByLabel('qa agent', { exact: true }).selectOption('codex-2');
  await module.getByLabel('Attach current Project Context', { exact: false }).check();
  await module.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await expect(module.getByText('Run: draft', { exact: false })).toBeVisible();
  await module
    .getByLabel('Conversation note', { exact: true })
    .fill('This is an operator note, not a generated AI response.');
  await module.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(
    module.getByText('This is an operator note, not a generated AI response.', { exact: true }),
  ).toBeVisible();
  await capture('lead-proposal');
  await module.getByRole('button', { name: 'Save as workflow template', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project modules' })
    .getByRole('button', { name: 'Workflow templates', exact: true })
    .click();
  await module.getByRole('button', { name: 'Duplicate template', exact: true }).click();
  await expect(module.getByLabel('Plan title', { exact: true })).toHaveValue(
    'Native workflow fixture proposal (copy)',
  );
  await module.getByRole('button', { name: 'Archive template', exact: true }).click();
  await expect(
    module.getByRole('button', { name: 'Create proposal from template', exact: true }),
  ).toBeDisabled();
  await capture('templates');
  await page
    .getByRole('navigation', { name: 'Project modules' })
    .getByRole('button', { name: 'Lead Agent', exact: true })
    .click();
  await module
    .getByRole('button', { name: 'Native workflow fixture proposal', exact: true })
    .click();
  assert.equal(env.store.tasks().length, 0);
  await module.getByRole('button', { name: 'Check prerequisites', exact: true }).click();
  await expect(module.getByText('Prerequisites checked.', { exact: false })).toBeVisible();
  assert.equal(env.store.tasks().length, 0);
  const createRun = module.getByRole('button', {
    name: 'Create workflow for approval',
    exact: true,
  });
  await expect(createRun).toBeDisabled();
  await module.getByLabel('I confirm creating a workflow', { exact: false }).check();
  await createRun.click();
  const board = page.getByRole('region', { name: 'Workflow review results', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Confirm workflow checkpoint' });
  const gate = async (label: string, configure?: () => Promise<void>) => {
    await expect(board.getByRole('button', { name: label, exact: true })).toBeEnabled({
      timeout: 45000,
    });
    await board.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Confirm checkpoint', exact: true }),
    ).toBeDisabled();
    if (configure) await configure();
    await dialog
      .getByRole('checkbox', { name: 'I approve this exact checkpoint', exact: true })
      .check();
    await dialog.getByRole('button', { name: 'Confirm checkpoint', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 45000 });
  };
  await expect(
    board.getByRole('button', { name: 'Approve Coder baseline', exact: true }),
  ).toBeEnabled();
  assert.equal(env.store.queue().length, 0);
  assert.equal(env.store.sessions().length, 0);
  await gate('Approve Coder baseline');
  await gate('Start Coder');
  await gate('Capture Coder evidence');
  await gate('Approve Coder evidence');
  await gate('Approve Reviewer input');
  await gate('Prepare Reviewer snapshot');
  await gate('Start Reviewer');
  await gate('Approve Reviewer result');
  await gate('Approve QA command', async () => {
    await dialog.getByLabel('Approved QA command').selectOption('source');
  });
  await gate('Start QA');
  await gate('Approve QA result');
  await module.getByRole('button', { name: 'Refresh project data', exact: true }).click();
  await expect(module.getByText('Run: completed', { exact: false })).toBeVisible();
  await capture('completed-run');
  const plan = new OrchestrationStore(env.store).plans(env.repositoryRecord.id)[0]!;
  const workflow = (await env.send('GET', '/api/workflows/' + plan.workflowId)).json();
  assert.equal(workflow.state, 'completed');
  const snapshotPattern = '**/api/repositories/*/orchestration';
  await page.route(snapshotPattern, (route) => route.abort());
  await module.getByRole('button', { name: 'Refresh project data', exact: true }).click();
  await expect(module.getByRole('alert')).toContainText('Actions are locked');
  await expect(module.getByRole('button', { name: 'New proposal', exact: true })).toBeDisabled();
  await page.unroute(snapshotPattern);
  await module.getByRole('button', { name: 'Refresh project data', exact: true }).click();
  await expect(module.getByRole('button', { name: 'New proposal', exact: true })).toBeEnabled();
  // Server-owned state is reloaded; no static status rows or fabricated model costs.
  await page.reload();
  await module
    .getByRole('button', { name: 'Native workflow fixture proposal', exact: true })
    .click();
  await expect(module.getByText('Run: completed', { exact: false })).toBeVisible();
  // An old repository response must never restore its proposals/context after switching.
  const otherPath = join(env.root, 'second-repository');
  execFileSync('/usr/bin/git', ['clone', '--quiet', '--local', env.repository, otherPath]);
  const other = env.store.register(await validateRepository(otherPath));
  await page.reload();
  await page
    .getByRole('combobox', { name: 'Repository', exact: true })
    .selectOption(env.repositoryRecord.id);
  await expect(
    module.getByRole('button', { name: 'Native workflow fixture proposal', exact: true }),
  ).toBeVisible();
  await page.route(snapshotPattern, async (route) => {
    if (route.request().url().includes(env.repositoryRecord.id)) {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ response });
    } else await route.continue();
  });
  await module.getByRole('button', { name: 'Refresh project data', exact: true }).click();
  await page.getByRole('combobox', { name: 'Repository', exact: true }).selectOption(other.id);
  await expect(
    module.getByText('No saved proposals in this repository.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Project modules' })
    .getByRole('button', { name: 'Project Context', exact: true })
    .click();
  await expect(module.getByLabel('Brief', { exact: true })).toHaveValue('');
  await page.unroute(snapshotPattern);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'verification.json'),
    JSON.stringify(
      {
        provenance:
          'deterministic SDK fixture + actual SQLite, HTTP, native Reviewer/QA sandbox; no model calls',
        viewports: [1440, 1920, 390],
        planId: plan.id,
        workflowId: plan.workflowId,
        state: workflow.state,
        stages: workflow.stages.map((stage: { kind: string; state: string }) => ({
          kind: stage.kind,
          state: stage.state,
        })),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Orchestration browser journey passed; screenshots and provenance: ${artifacts}`);
} finally {
  await browser.close();
  await env.cleanup();
}
