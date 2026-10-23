import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const script = resolve('scripts/diagnose-lock.mjs');
const directories: string[] = [];

function fixture(owner?: unknown, createLease = true) {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-lock-diagnostic-'));
  directories.push(root);
  if (createLease) {
    const lease = join(root, '.ai-office', 'server.lock');
    mkdirSync(lease, { recursive: true });
    if (owner !== undefined) {
      writeFileSync(join(lease, 'owner.json'), JSON.stringify(owner));
    }
  }
  return root;
}

function diagnose(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('reports no lease without creating any runtime files', () => {
  const cwd = fixture(undefined, false);
  const result = diagnose(cwd);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('No AI Office server lease exists');
});

it('fails closed when owner metadata is missing', () => {
  const result = diagnose(fixture());
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('missing or invalid');
});

it('fails closed when the owner PID is alive', () => {
  const result = diagnose(
    fixture({ pid: process.pid, detail: 'AI Office metadata', at: '2026-10-23T01:25:18Z' }),
  );
  expect(result.status).toBe(2);
  expect(result.stdout).toContain('Owner PID:');
  expect(result.stderr).toContain('A process currently has this PID');
});

it('reports a nonexistent PID without moving or deleting the lease', () => {
  const cwd = fixture({ pid: 2147483647, detail: 'AI Office metadata', at: '2026-10-23' });
  const result = diagnose(cwd);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('recorded PID is not running');
  expect(result.stdout).toContain('Verify no other AI Office instance');
});
