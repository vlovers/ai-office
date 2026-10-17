import { test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('real write harness prepares without Codex and refuses unapproved, replaced and repeated runs', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ai-office-smoke-guard-'));
  const env = { PATH: '/usr/bin:/bin', HOME: parent, CODEX_HOME: parent, TMPDIR: parent };
  const invoke = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/real-write-smoke.ts'), ...args],
      { env, encoding: 'utf8', timeout: 10_000 },
    );
  try {
    expect(invoke().status).not.toBe(0);
    expect(invoke('--run').status).not.toBe(0);
    const prepared = invoke('--prepare');
    expect(prepared.status, prepared.stderr).toBe(0);
    const root = prepared.stdout.trim().split('Prepared without model usage: ')[1]!;
    const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
    expect(fixture.root).toBe(root);
    const repository = join(root, 'repository');
    expect(
      execFileSync('/usr/bin/git', ['-C', repository, 'status', '--porcelain'], {
        env,
        encoding: 'utf8',
      }),
    ).toBe('');
    const alias = join(parent, 'ai-office-real-write-alias');
    await symlink(root, alias);
    expect(invoke('--run', '--root', alias, '--model', 'never-call').status).not.toBe(0);
    await writeFile(join(root, 'run-claimed'), 'already attempted');
    const repeated = invoke('--run', '--root', root, '--model', 'never-call');
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toMatch(/EEXIST/);
    // No database or worker was created: execution never reached Codex.
    await expect(readFile(join(root, 'metadata.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
