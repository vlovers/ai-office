import { mkdtemp, chmod, rm, stat, symlink, link, writeFile, realpath } from 'node:fs/promises';
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

it('refuses public pre-existing database without changing its mode or bytes', async () => {
  const directory = await root();
  const database = join(directory, 'delivery.sqlite');
  await writeFile(database, 'do not modify', { mode: 0o644 });
  await expect(openDeliveryDatabase(directory)).rejects.toThrow('unavailable');
  expect((await stat(database)).mode & 0o777).toBe(0o644);
  expect(await (await import('node:fs/promises')).readFile(database, 'utf8')).toBe(
    'do not modify',
  );
});

it('refuses unsafe existing data directories rather than chmod-repairing them', async () => {
  const directory = await root();
  await chmod(directory, 0o755);
  await expect(openDeliveryDatabase(directory)).rejects.toThrow('unavailable');
  expect((await stat(directory)).mode & 0o777).toBe(0o755);
});

it('refuses SQLite symlinks, hardlinks and non-regular files before SQLite opens', async () => {
  const directory = await root();
  const source = join(directory, 'source.db');
  const database = join(directory, 'delivery.sqlite');
  await writeFile(source, 'external content', { mode: 0o600 });
  await symlink(source, database);
  await expect(openDeliveryDatabase(directory)).rejects.toThrow();
  await rm(database);
  await link(source, database);
  await expect(openDeliveryDatabase(directory)).rejects.toThrow('unavailable');
  expect((await stat(source)).nlink).toBe(2);
  await rm(database);
  await rm(source);
  await (await import('node:fs/promises')).mkdir(database);
  await expect(openDeliveryDatabase(directory)).rejects.toThrow();
});

it('does not relax private database permissions across a successful restart', async () => {
  const directory = await root();
  const first = await openDeliveryDatabase(directory);
  first.close();
  const database = join(directory, 'delivery.sqlite');
  expect((await stat(database)).mode & 0o077).toBe(0);
  const second = await openDeliveryDatabase(directory);
  second.close();
  expect((await stat(database)).mode & 0o077).toBe(0);
});
