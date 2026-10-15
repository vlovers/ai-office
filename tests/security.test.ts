import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { sandbox } from './helpers.js';
import { codexOptions, threadOptions } from '../src/server/providers/codex-config.js';
import { acquireLock } from '../src/server/lock.js';
import { join } from 'node:path';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it('rejects shell/options injection, cross-origin requests, and DNS rebinding', async () => {
  const env = await sandbox();
  const app = await createApp(env.manager);
  cleanups.push(async () => {
    await app.close();
    await env.cleanup();
  });
  const headers = { host: '127.0.0.1:4310' };
  expect(
    (await app.inject({ url: '/api/dashboard', headers: { host: 'evil.example:4310' } }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: '/api/dashboard',
        headers: { ...headers, origin: 'https://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: '/api/dashboard',
        headers: { ...headers, 'sec-fetch-site': 'cross-site' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers,
        payload: { path: env.repository, command: 'touch bad' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/exec',
        headers,
        payload: { command: 'whoami' },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { ...headers, 'content-type': 'text/plain' },
        payload: 'shell command',
      })
    ).statusCode,
  ).toBe(415);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers,
        payload: { path: env.repository },
      })
    ).statusCode,
  ).toBe(201);
});
it('keeps permission paths atomic and denies unregistered filesystem access', () => {
  const options = codexOptions('/tmp/example.with dots', {});
  expect(options.configOverrides?.[0]).toContain('"/tmp/example.with dots"={"."="read"');
  expect(options.configOverrides?.[0]).toContain('\":root\"=\"deny\"');
  expect(options.config?.approval_policy).toBe('on-request');
  expect(options.config?.approvals_reviewer).toBe('user');
  expect(threadOptions('/repo').sandboxMode).toBeUndefined();
  expect(threadOptions('/repo').skipGitRepoCheck).toBe(false);
});
it('fails closed on existing leases rather than sharing a worktree', async () => {
  const env = await sandbox();
  cleanups.push(env.cleanup);
  const lock = join(env.root, 'lease');
  const release = await acquireLock(lock, 'test');
  await expect(acquireLock(lock, 'test')).rejects.toThrow('locked');
  await release();
  await (
    await acquireLock(lock, 'test')
  )();
});
