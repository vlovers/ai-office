import { mkdtemp, chmod, rm, stat, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DeliverySessions } from '../src/server/delivery-sessions.js';
import {
  openDeliveryDatabase,
  readDeliverySecurityConfig,
} from '../src/server/delivery-security-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-delivery-runtime-')));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

it('accepts private regular config and refuses symlinks, world-readable config, oversized input and HTTP origin', async () => {
  const directory = await root();
  const config = join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({ publicOrigin: 'https://delivery.example.test', workspaces: [] }),
    { mode: 0o600 },
  );
  expect((await readDeliverySecurityConfig(config)).workspaces).toEqual([]);
  const alias = join(directory, 'alias.json');
  await symlink(config, alias);
  await expect(readDeliverySecurityConfig(alias)).rejects.toThrow();
  await chmod(config, 0o644);
  await expect(readDeliverySecurityConfig(config)).rejects.toThrow();
  await chmod(config, 0o600);
  await writeFile(config, 'x'.repeat(1024 * 1024 + 1));
  await expect(readDeliverySecurityConfig(config)).rejects.toThrow();
  await writeFile(
    config,
    JSON.stringify({ publicOrigin: 'http://delivery.example.test', workspaces: [] }),
  );
  await expect(readDeliverySecurityConfig(config)).rejects.toThrow();
});

it('preserves security state on close/reopen with private SQLite and refuses future schema versions', async () => {
  const directory = await root();
  const db = await openDeliveryDatabase(directory);
  const sessions = new DeliverySessions(db);
  sessions.setOperator('operator', true);
  sessions.setGrant('operator', 'workspace', 'review', true);
  const ticket = sessions.issueEnrollment('operator');
  const session = sessions.exchangeEnrollment(ticket);
  sessions.revoke(session.token);
  db.close();
  expect((await stat(join(directory, 'delivery.sqlite'))).mode & 0o077).toBe(0);
  const reopened = await openDeliveryDatabase(directory);
  try {
    const restored = new DeliverySessions(reopened);
    expect(() => restored.authenticate(session.token)).toThrow('authentication');
    expect(() => restored.exchangeEnrollment(ticket)).toThrow('authentication');
    reopened.exec('UPDATE delivery_security_version SET version=2');
    expect(() => new DeliverySessions(reopened)).toThrow('unavailable');
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM delivery_operator_sessions').get()?.n).toBe(
      1,
    );
  } finally {
    reopened.close();
  }
});

it('never restores outstanding enrollment tickets when a disabled operator is re-enabled', async () => {
  const db = await openDeliveryDatabase(await root());
  try {
    const sessions = new DeliverySessions(db);
    sessions.setOperator('operator', true);
    const ticket = sessions.issueEnrollment('operator');
    sessions.setOperator('operator', false);
    expect(() => sessions.issueEnrollment('operator')).toThrow('denied');
    sessions.setOperator('operator', true);
    expect(() => sessions.exchangeEnrollment(ticket)).toThrow('authentication');
  } finally {
    db.close();
  }
});
