import { afterEach, expect, it } from 'vitest';
import { sandbox, until } from './helpers.js';
import { CodexAuth, inspectLocal } from '../src/server/providers/codex-auth.js';
import { localCli } from '../src/server/providers/codex-metadata.js';
import { validateRepository } from '../src/server/repositories.js';
import { createApp } from '../src/server/app.js';

const cleanups: (() => Promise<void>)[] = [];
it('allows only a server-selected absolute CLI path and preserves the environment whitelist', async () => {
  await expect(inspectLocal('./untrusted-cli')).rejects.toThrow('must be absolute');
  const selected = localCli('/operator/configured/codex');
  expect(selected.executable).toBe('/operator/configured/codex');
  expect(
    Object.keys(selected.env).every((key) => ['PATH', 'HOME', 'CODEX_HOME'].includes(key)),
  ).toBe(true);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('prefers ChatGPT even with an API key and strips credential/environment inheritance', async () => {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const auth = new CodexAuth({
    dataDir: env.root,
    apiKey: 'synthetic-test-key',
    inspectLocal: async () => ({
      ...env.inspection,
      env: {
        ...env.inspection.env,
        CODEX_API_KEY: 'must-not-pass',
        OPENAI_API_KEY: 'must-not-pass',
        DATABASE_URL: 'must-not-pass',
      },
    }),
    apiExecutable: env.executable,
  });
  await auth.refresh();
  expect(auth.view().mode).toBe('local-cli-chatgpt');
  expect(auth.view().status).toBe('available');
  const local = await auth.prepare();
  expect(local.env).not.toHaveProperty('CODEX_API_KEY');
  expect(local.env).not.toHaveProperty('OPENAI_API_KEY');
  expect(local.env).not.toHaveProperty('DATABASE_URL');
  await auth.select('api-key');
  const api = await auth.prepare();
  expect(api.env.CODEX_API_KEY).toBe('synthetic-test-key');
  expect(api.env.CODEX_HOME).not.toBe(local.env.CODEX_HOME);
  await expect(auth.prepare(local.binding)).rejects.toThrow('connection mode');
});

it.each(['none', 'apiKey', 'other'] as const)(
  'requires local ChatGPT login for account %s without paid fallback',
  async (account) => {
    const env = await sandbox();
    cleanups.push(env.cleanup);
    const auth = new CodexAuth({
      dataDir: env.root,
      apiKey: 'synthetic-test-key',
      inspectLocal: async () => ({ ...env.inspection, account }),
    });
    await auth.refresh();
    expect(auth.view().mode).toBe('local-cli-chatgpt');
    expect(auth.view().status).toBe('authentication-required');
    await expect(auth.prepare()).rejects.toThrow('Authentication required');
    expect(auth.view().mode).toBe('local-cli-chatgpt');
  },
);

it('turns metadata/unsupported-runtime errors into non-sensitive Connection error', async () => {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const auth = new CodexAuth({
    dataDir: env.root,
    inspectLocal: async () => {
      throw new Error('SYNTHETIC_PRIVATE_AUTH_DETAIL');
    },
  });
  await auth.refresh();
  expect(auth.view().status).toBe('connection-error');
  expect(JSON.stringify(auth.view())).not.toContain('SYNTHETIC_PRIVATE');
  const unsupported = new CodexAuth({
    dataDir: env.root,
    inspectLocal: async () => ({ ...env.inspection, version: 'unknown' }),
  });
  expect((await unsupported.refresh()).status).toBe('connection-error');
});

it('rechecks login before task execution and rejects a changed execution context on resume', async () => {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const execution = await env.auth.prepare();
  env.inspection.account = 'none';
  await expect(env.auth.prepare()).rejects.toThrow('Authentication required');
  env.inspection.account = 'chatgpt';
  env.inspection.env = { ...env.inspection.env, CODEX_HOME: env.root + '/changed-home' };
  await expect(env.auth.prepare(execution.binding)).rejects.toThrow('context changed');
});

it('maps an expired real-runtime-style login failure to Authentication required without leaking diagnostics', async () => {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const repo = env.store.register(await validateRepository(env.repository));
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Expired login',
    prompt: 'AUTH_FIXTURE',
  });
  env.manager.start(task.id);
  await until(
    () => env.store.task(task.id)!,
    (value) => value.state === 'failed',
  );
  expect(env.manager.dashboard().connection.status).toBe('authentication-required');
  expect(env.manager.dashboard().connection.mode).toBe('local-cli-chatgpt');
  const persisted = JSON.stringify([env.store.task(task.id), env.store.events(task.id)]);
  expect(persisted).not.toContain('AUTH_SECRET_SYNTHETIC');
  expect(persisted).toContain('Authentication required');
  const next = env.store.createTask({
    repositoryId: repo.id,
    title: 'Try again',
    prompt: 'review',
  });
  expect(() => env.manager.start(next.id)).toThrow('Authentication required');
});

it('exposes only safe connection metadata and rejects auth internals in HTTP requests', async () => {
  const env = await sandbox();
  const app = await createApp(env.manager);
  cleanups.push(async () => {
    await app.close();
    await env.cleanup();
  });
  const headers = { host: '127.0.0.1:4310' };
  const response = await app.inject({ url: '/api/dashboard', headers });
  const payload = response.json();
  expect(Object.keys(payload.connection).sort()).toEqual([
    'checkedAt',
    'message',
    'mode',
    'modes',
    'status',
  ]);
  expect(response.body).not.toContain(env.inspection.env.HOME);
  for (const field of ['apiKey', 'executable', 'env', 'home']) {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/connection',
          headers,
          payload: { mode: 'api-key', [field]: 'forbidden' },
        })
      ).statusCode,
    ).toBe(400);
  }
  const api = await app.inject({
    method: 'POST',
    url: '/api/connection',
    headers,
    payload: { mode: 'api-key' },
  });
  expect(api.json().status).toBe('authentication-required');
  const local = await app.inject({
    method: 'POST',
    url: '/api/connection',
    headers,
    payload: { mode: 'local-cli-chatgpt' },
  });
  expect(local.json().status).toBe('available');
});

it('prevents changing billing mode while a task or connection check is active', async () => {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const repo = env.store.register(await validateRepository(env.repository));
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Wait',
    prompt: 'WAIT_FIXTURE',
  });
  env.manager.start(task.id);
  await expect(env.manager.selectConnection('api-key')).rejects.toThrow('active agent');
  await env.manager.stop(task.id);
  const checking = env.manager.refreshConnection();
  await expect(env.manager.selectConnection('api-key')).rejects.toThrow('connection check');
  await checking;
});
