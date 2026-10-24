import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliveryHTTP, deliverySecurityFixture, origin } from './fixtures/delivery-security.js';

async function start(directory: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server/delivery-security-index.ts'],
    {
      env: {
        ...process.env,
        AI_OFFICE_DELIVERY_DATA_DIR: directory,
        AI_OFFICE_DELIVERY_CONFIG: join(directory, 'config.json'),
        AI_OFFICE_DELIVERY_PORT: '0',
        AI_OFFICE_DELIVERY_GITHUB_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Delivery child startup timed out.'));
    }, 10_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Delivery child failed.'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Delivery child exited before readiness.'));
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /loopback port (\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${match[1]}` });
      }
    });
  });
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

describe('production Delivery independent-process startup', () => {
  it('retains sessions/one-use intents across restart, recovers under the Git lease and observes admin revocation', async () => {
    const t = await deliverySecurityFixture();
    let first: Awaited<ReturnType<typeof start>> | undefined;
    let second: Awaited<ReturnType<typeof start>> | undefined;
    try {
      await t.app.close();
      writeFileSync(
        join(t.root, 'config.json'),
        JSON.stringify({ publicOrigin: origin, workspaces: [t.workspace] }),
        { mode: 0o600 },
      );
      first = await start(t.root);
      const headers = {
        host: 'delivery.example.test',
        origin,
        cookie: t.auth.cookie,
        'x-csrf-token': t.auth.body.csrfToken,
        'Content-Type': 'application/json',
      };
      const review = (await (
        await deliveryHTTP(`${first.url}/api/delivery/workspaces/workspace-a/review`, { headers })
      ).json()) as { reviewId: string };
      const approved = (await (
        await deliveryHTTP(`${first.url}/api/delivery/workspaces/workspace-a/approvals`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reviewId: review.reviewId, operation: 'commit', confirmed: true }),
        })
      ).json()) as { approvalId: string };
      const body = JSON.stringify({
        reviewId: review.reviewId,
        approvalId: approved.approvalId,
        stage: 'commit',
        confirmed: true,
      });
      expect(
        (
          await deliveryHTTP(`${first.url}/api/delivery/workspaces/workspace-a/transfer-intents`, {
            method: 'POST',
            headers,
            body,
          })
        ).status,
      ).toBe(201);
      expect(t.service.journal.get('workspace-a', 'commit')?.state).toBe('intent');
      // Another independently bootstrapped process cannot own the metadata lock.
      const competing = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/server/delivery-security-index.ts'],
        {
          env: {
            ...process.env,
            AI_OFFICE_DELIVERY_DATA_DIR: t.root,
            AI_OFFICE_DELIVERY_CONFIG: join(t.root, 'config.json'),
            AI_OFFICE_DELIVERY_PORT: '0',
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(competing.status).toBe(1);
      expect(competing.stderr).not.toContain(t.auth.token);
      await stop(first.child);
      second = await start(t.root);
      expect((await deliveryHTTP(`${second.url}/api/delivery/session`, { headers })).status).toBe(
        200,
      );
      expect(t.service.journal.get('workspace-a', 'commit')?.state).toBe('uncertain');
      expect(
        (
          await deliveryHTTP(`${second.url}/api/delivery/workspaces/workspace-a/transfer-intents`, {
            method: 'POST',
            headers,
            body,
          })
        ).status,
      ).toBe(409);
      const revoke = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/delivery-admin.ts', 'disable', 'alice'],
        {
          env: { ...process.env, AI_OFFICE_DELIVERY_DATA_DIR: t.root },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(revoke.status).toBe(0);
      expect(revoke.stdout).toBe('');
      expect((await deliveryHTTP(`${second.url}/api/delivery/session`, { headers })).status).toBe(
        401,
      );
      expect(t.git('rev-parse', 'HEAD')).toBe(t.workspace.headSha);
    } finally {
      await stop(first?.child);
      await stop(second?.child);
      await t.close();
    }
  }, 30_000);

  it('fails startup on missing trusted configuration with a fixed error and no credential leakage', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/server/delivery-security-index.ts'],
      {
        env: {
          ...process.env,
          AI_OFFICE_DELIVERY_CONFIG: '/nonexistent/credential-marker',
          AI_OFFICE_DELIVERY_GITHUB_TOKEN: 'github_pat_SECRET_MARKER',
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('SECRET_MARKER');
    expect(result.stderr).not.toContain('/nonexistent');
  });
});
