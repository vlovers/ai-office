import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { createDeliverySecurityApp } from '../../src/server/delivery-security-app.js';
import {
  DeliverySecurityService,
  type DeliverySecurityWorkspace,
} from '../../src/server/delivery-security-service.js';
import { DeliverySessions, deliveryOperationSchema } from '../../src/server/delivery-sessions.js';
import type { DeliveryGitHubCredentials } from '../../src/server/delivery-github-credentials.js';

export const origin = 'https://delivery.example.test';
export const cookieName = '__Host-ai-office-delivery';

/** Raw HTTP models a TLS proxy preserving public Host on its loopback hop. */
export function deliveryHTTP(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: init.method ?? 'GET', headers: init.headers as Record<string, string> },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers as Record<string, string>,
            }),
          ),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

export async function deliverySecurityFixture(
  credentialFactory?: (db: DatabaseSync, now: () => number) => DeliveryGitHubCredentials,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-delivery-security-')));
  const path = join(root, 'repo');
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', path]);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.name', 'Security Test');
  git('config', 'user.email', 'security@example.invalid');
  writeFileSync(join(path, 'README'), 'base\n');
  git('add', 'README');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const branch = 'ai-office/12345678-1234-1234-1234-123456789abc';
  git('checkout', '-qb', branch);
  writeFileSync(join(path, 'README'), 'reviewed\n');
  git('add', 'README');
  git('commit', '-qm', 'reviewed');
  git('remote', 'add', 'origin', 'https://github.com/vlovers/ai-office');
  const repository = { path, gitDir: realpathSync(join(path, '.git')) };
  const workspace: DeliverySecurityWorkspace = {
    workspaceId: 'workspace-a',
    repository,
    worktree: repository,
    plan: {
      allowed: true,
      destination: 'https://github.com/vlovers/ai-office',
      branch,
      baseBranch: 'main',
      revision: 'a'.repeat(64),
      draft: true,
    },
    headSha: git('rev-parse', 'HEAD'),
    baseSha,
  };
  const dbPath = join(root, 'delivery.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;');
  const clock: { value?: number } = {};
  const now = () => clock.value ?? Date.now();
  const sessions = new DeliverySessions(db, now);
  for (const operatorId of ['alice', 'bob']) {
    sessions.setOperator(operatorId, true);
    for (const operation of deliveryOperationSchema.options)
      sessions.setGrant(operatorId, 'workspace-a', operation, true);
  }
  const service = new DeliverySecurityService(sessions, [workspace], credentialFactory?.(db, now));
  const app = createDeliverySecurityApp(service, origin);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const ticket = sessions.issueEnrollment('alice');
  async function login(operatorId = 'alice') {
    const response = await deliveryHTTP(`${url}/api/delivery/session`, {
      method: 'POST',
      headers: {
        host: 'delivery.example.test',
        origin,
        'Content-Type': 'application/json',
        'x-delivery-enrollment': '1',
      },
      body: JSON.stringify({
        ticket: operatorId === 'alice' ? ticket : sessions.issueEnrollment(operatorId),
      }),
    });
    const body = (await response.json()) as { csrfToken: string; expiresAt: number };
    if (response.status !== 200) {
      await app.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
      throw new Error(`Fixture enrollment failed: ${response.status} ${JSON.stringify(body)}`);
    }
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { response, body, cookie, token: cookie.slice(cookieName.length + 1) };
  }
  const auth = await login();
  async function request(
    route: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      cookie?: string;
    } = {},
  ) {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const response = await deliveryHTTP(`${url}/api/delivery${route}`, {
      method,
      headers: {
        host: 'delivery.example.test',
        origin,
        'Content-Type': 'application/json',
        cookie: options.cookie ?? auth.cookie,
        'x-csrf-token': auth.body.csrfToken,
        ...options.headers,
      },
      body:
        options.body === undefined
          ? undefined
          : typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body),
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  }
  return {
    root,
    db,
    dbPath,
    clock,
    now,
    sessions,
    service,
    app,
    url,
    git,
    workspace,
    auth,
    ticket,
    login,
    request,
    close: async () => {
      await app.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
