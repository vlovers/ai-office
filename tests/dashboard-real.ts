/** Explicit opt-in live production dashboard test. Consumes ChatGPT Codex allowance/credits. */
import { chromium } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { MetadataClient, localCli } from '../src/server/providers/codex-metadata.js';
import type { Dashboard, AgentEvent } from '../src/shared/types.js';

if (!process.argv.includes('--run'))
  throw new Error('Pass --run to authorize real ChatGPT Codex usage.');
process.umask(0o077);
const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-dashboard-real-')));
const repository = join(root, 'example');
await mkdir(repository);
execFileSync('/usr/bin/git', ['init', '--quiet', repository], {
  env: {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  },
  stdio: 'ignore',
});
const marker = `DASHBOARD_REAL_${randomUUID()}`;
const original = `# Disposable dashboard verification\n\nRepository marker: ${marker}\n`;
await writeFile(join(repository, 'README.md'), original);
const evidence = resolve('.ai-office/verification', `dashboard-real-${Date.now()}`);
const data = join(evidence, 'data');
await mkdir(data, { recursive: true });
const started = performance.now();
const report: Record<string, unknown> = {
  kind: 'REAL_DASHBOARD_MODEL_TEST',
  startedAt: new Date().toISOString(),
  authentication: 'local-cli-chatgpt',
  apiKeyEnvironmentForwarded: false,
  apiKeyFallback: false,
  readOnly: true,
  turns: [],
  errors: [],
};
let backend: ChildProcess | undefined;
let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function startBackend(): Promise<string> {
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    AI_OFFICE_DATA_DIR: data,
    AI_OFFICE_PORT: '0',
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  backend = spawn(process.execPath, [resolve('dist/server/index.js')], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const child = backend;
  closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('Backend startup timeout. Raw diagnostics withheld.')),
      55000,
    );
    child.stdout!.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-4000);
      const address = /AI Office: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (address) {
        clearTimeout(timer);
        resolve(address);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not launch production backend.'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Backend exited before becoming available.'));
    });
  });
}
async function stopBackend() {
  if (!backend || !closed) return;
  const child = backend;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* exited */
      }
    }
  }, 20000);
  const status = await closed;
  clearTimeout(timer);
  backend = undefined;
  assert.equal(status.code, 0, 'Backend did not shut down gracefully.');
  await assert.rejects(
    access(join(data, 'server.lock')),
    'Server lock survived graceful shutdown.',
  );
}
try {
  let address = await startBackend();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const pageErrors: string[] = [];
  page.on('pageerror', () => pageErrors.push('Browser page error.'));
  let streams = 0;
  page.on('response', (response) => {
    if (response.url().includes('/stream') && response.status() === 200) streams++;
  });
  const dashboard = async (): Promise<Dashboard> =>
    (await fetch(`${address}/api/dashboard`)).json() as Promise<Dashboard>;
  await page.goto(address);
  await page.getByTestId('codex-connection-status').filter({ hasText: 'Available' }).waitFor();
  let snapshot = await dashboard();
  assert.equal(snapshot.connection.mode, 'local-cli-chatgpt');
  assert.equal(
    snapshot.connection.modes.find((mode) => mode.mode === 'api-key')?.status,
    'authentication-required',
  );
  // Explicit UI selection, with no key available and no inference in API mode.
  await page.getByLabel('Authentication mode').selectOption('api-key');
  await page
    .getByTestId('codex-connection-status')
    .filter({ hasText: 'Authentication required' })
    .waitFor();
  await page.getByLabel('Authentication mode').selectOption('local-cli-chatgpt');
  await page.getByTestId('codex-connection-status').filter({ hasText: 'Available' }).waitFor();
  await page.getByLabel('Absolute repository path').fill(repository);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Task title').fill('Real dashboard read-only review');
  await page
    .getByLabel('What should the agent work on?')
    .fill(
      'Read only README.md using a read-only tool. Return the exact Repository marker. Do not write anything or read other files.',
    );
  await page.getByRole('button', { name: 'Create task' }).click();
  const firstStart = performance.now();
  await page.getByRole('button', { name: 'Start task' }).click();
  await page
    .locator('.task-toolbar .badge')
    .filter({ hasText: 'completed' })
    .waitFor({ timeout: 120000 });
  await page.getByRole('heading', { name: 'Final result' }).waitFor({ timeout: 120000 });
  assert.ok(
    (await page.locator('.result').innerText()).includes(marker),
    'Real model did not read the repository marker.',
  );
  snapshot = await dashboard();
  const first = snapshot.tasks.find((task) => task.title === 'Real dashboard read-only review')!;
  assert.equal(first.state, 'completed', first.error ?? 'First task failed.');
  const session = snapshot.sessions.find((session) => session.id === first.sessionId)!;
  assert.ok(session.threadId);
  assert.equal(session.authMode, 'local-cli-chatgpt');
  const firstEvents = (await (
    await fetch(`${address}/api/tasks/${first.id}/events`)
  ).json()) as AgentEvent[];
  assert.ok(firstEvents.some((event) => event.kind === 'thread'));
  assert.ok(firstEvents.some((event) => event.kind === 'result'));
  assert.ok(
    firstEvents.some((event) => event.message.includes(marker) && event.kind === 'progress'),
  );
  (report.turns as unknown[]).push({
    taskId: first.id,
    threadId: session.threadId,
    model: session.model,
    durationMs: Math.round(performance.now() - firstStart),
    state: first.state,
    sdkEventsThroughSse: true,
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, 'desktop.png'), fullPage: true });
  await page.goto('about:blank'); // disconnect old SSE before stopping the process
  await stopBackend();
  address = await startBackend();
  await page.goto(address);
  await page.getByRole('button', { name: /Real dashboard read-only review/ }).click();
  await page.getByRole('heading', { name: 'Final result' }).waitFor();
  assert.ok(
    (await page.locator('.result').innerText()).includes(marker),
    'Completed result was lost on restart.',
  );
  await page.getByLabel('Task title').fill('Real dashboard resumed review');
  await page
    .getByLabel('What should the agent work on?')
    .fill('Without rereading files, repeat the exact Repository marker from the previous turn.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('combobox', { name: 'Session' }).selectOption(session.id);
  const secondStart = performance.now();
  await page.getByRole('button', { name: 'Start task' }).click();
  await page
    .locator('.task-toolbar .badge')
    .filter({ hasText: 'completed' })
    .waitFor({ timeout: 120000 });
  await page.getByRole('heading', { name: 'Final result' }).waitFor({ timeout: 120000 });
  assert.ok(
    (await page.locator('.result').innerText()).includes(marker),
    'Resumed model did not recall the marker.',
  );
  snapshot = await dashboard();
  const second = snapshot.tasks.find((task) => task.title === 'Real dashboard resumed review')!;
  assert.equal(second.state, 'completed', second.error ?? 'Resume failed.');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(
    snapshot.sessions.find((item) => item.id === session.id)?.threadId,
    session.threadId,
  );
  (report.turns as unknown[]).push({
    taskId: second.id,
    threadId: session.threadId,
    durationMs: Math.round(performance.now() - secondStart),
    state: second.state,
    resumedAfterBackendRestart: true,
  });
  assert.ok(streams >= 2, 'Browser did not receive live SSE connections.');
  report.sseConnections = streams;
  assert.deepEqual(pageErrors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Mobile layout overflows.',
  );
  await page.screenshot({ path: join(evidence, 'mobile.png'), fullPage: true });
  const local = localCli();
  const metadata = new MetadataClient(local.executable, local.env, repository);
  try {
    await metadata.initialize();
    const native = await metadata.thread(session.threadId);
    report.persistedModel = native.model;
    report.nativeThreadPersistent = !native.ephemeral;
    assert.equal(native.model, session.model);
  } finally {
    await metadata.close();
  }
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), original);
  const status = execFileSync(
    '/usr/bin/git',
    ['--no-optional-locks', '-C', repository, 'status', '--porcelain'],
    {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(status.trim(), '?? README.md');
  report.repositoryUnchanged = true;
  report.outcome = 'passed';
} catch (error) {
  // Test-owned assertions contain no account/auth payloads. Never include raw provider diagnostics.
  (report.errors as string[]).push(
    error instanceof Error ? error.message.slice(0, 200) : 'Live dashboard test failed.',
  );
  report.outcome = 'failed';
  process.exitCode = 1;
} finally {
  await browser?.close();
  try {
    await stopBackend();
  } catch {
    (report.errors as string[]).push('Backend cleanup failed. Inspect its lock before reuse.');
    process.exitCode = 1;
    report.outcome = 'failed';
  }
  await rm(root, { recursive: true, force: true });
  report.durationMs = Math.round(performance.now() - started);
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
}
