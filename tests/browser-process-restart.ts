// A real separate-process backend restart while the production React page stays mounted.
// This uses deterministic DB/SDK fixtures; it does not call a model or run a workflow.
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { sandbox, removeTestTree } from './helpers.js';

const env = await sandbox();
const repoGitDir = execFileSync('/usr/bin/git', ['-C', env.repository, 'rev-parse', '--absolute-git-dir'], {
  encoding: 'utf8',
}).trim();
const repo = env.store.register({ name: 'Restart browser fixture', path: env.repository, gitDir: repoGitDir });
const interrupted = env.store.createTask({
  repositoryId: repo.id, agentId: 'codex-1', title: 'Crash-recovery task',
  prompt: 'Fixture only — must never be submitted', executionMode: 'read-only',
});
const pending = env.store.createTask({
  repositoryId: repo.id, agentId: 'codex-2', title: 'Unsubmitted task',
  prompt: 'Fixture only — must stay unsubmitted', executionMode: 'read-only',
});
await env.manager.shutdown();
env.store.close();

const temp = createServer();
await new Promise<void>((accept, reject) => {
  temp.once('error', reject);
  temp.listen(0, '127.0.0.1', () => accept());
});
const endpoint = temp.address();
assert.ok(endpoint && typeof endpoint !== 'string');
const port = endpoint.port;
await new Promise<void>((accept) => temp.close(() => accept()));

const fixtureScript = resolve('tests/fixtures/restart-browser-server.mjs');
let child: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const terminate = async (processToStop: ChildProcess | undefined) => {
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const exit = new Promise<void>((accept) => processToStop.once('exit', () => accept()));
  processToStop.kill('SIGKILL');
  await exit;
};
const start = async (): Promise<ChildProcess> => {
  const processToStart = fork(fixtureScript, [env.root, String(port)], {
    cwd: process.cwd(), execArgv: [], silent: true,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: env.root,
      AI_OFFICE_ALLOW_HOST_VERIFICATION: '0',
    },
  });
  try {
    await new Promise<void>((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error('Backend fixture startup deadline')), 15000);
      let stderr = '';
      processToStart.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + String(chunk)).slice(-1500);
      });
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        processToStart.off('message', onMessage);
        processToStart.off('exit', onExit);
        if (error) reject(error);
        else accept();
      };
      const onMessage = (value: unknown) => {
        if ((value as { type?: string })?.type === 'ready') finish();
      };
      const onExit = () => finish(new Error('Backend exited before ready: ' + stderr));
      processToStart.on('message', onMessage);
      processToStart.once('exit', onExit);
    });
  } catch (error) {
    await terminate(processToStart);
    throw error;
  }
  return processToStart;
};

try {
  child = await start();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const address = 'http://127.0.0.1:' + port;
  await page.goto(address);
  const connection = page.locator('.connection');
  await expect(connection).toContainText(/^(Local server connected|Live events connected)$/, {
    timeout: 10000,
  });
  const originalDocument = await page.evaluate(() => {
    (window as Window & { __restartFixture?: string }).__restartFixture = 'preserved';
    return document.documentElement.tagName;
  });
  assert.ok(originalDocument);
  // Write synthetic unfinished state into the persistent DB while backend #1
  // is still alive. This simulates an unclean process exit with a running turn,
  // without creating a provider request or a runnable queue entry.
  const db = new DatabaseSync(join(env.root, 'metadata.sqlite'));
  try {
    const row = db.prepare('SELECT json FROM tasks WHERE id=?').get(interrupted.id);
    assert.ok(row);
    const task = JSON.parse(String(row.json));
    task.state = 'running';
    db.prepare('UPDATE tasks SET state=?, json=? WHERE id=?').run('running', JSON.stringify(task), interrupted.id);
  } finally {
    db.close();
  }
  await terminate(child);
  child = undefined;
  await expect(connection).toContainText('Server disconnected', { timeout: 12000 });
  child = await start();
  await expect(connection).toContainText(/^(Local server connected|Live events connected)$/, {
    timeout: 12000,
  });
  await expect
    .poll(async () => page.evaluate(() => (window as Window & { __restartFixture?: string }).__restartFixture))
    .toBe('preserved');
  await expect
    .poll(async () => {
      const res = await page.request.get(address + '/api/dashboard');
      const result = await res.json();
      return result.tasks.find((task: { id: string }) => task.id === interrupted.id)?.state;
    })
    .toBe('interrupted');
  const response = await page.request.get(address + '/api/dashboard');
  const snapshot = await response.json();
  assert.equal(snapshot.tasks.find((t: { id: string }) => t.id === pending.id)?.state, 'queued');
  assert.equal(snapshot.queue.length, 0, 'Never-submitted tasks must not run after restart');
  assert.equal(errors.length, 0, 'Unexpected browser errors: ' + errors.join(' | '));
} finally {
  await terminate(child);
  await browser?.close();
  await removeTestTree(env.root);
}
