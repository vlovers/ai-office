// Credential-free safety probe of the INSTALLED Codex runtime, with no model call.
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { codexOptions } from '../src/server/providers/codex-config.js';

if (!['darwin', 'linux'].includes(process.platform))
  throw new Error('Native sandbox probe supports macOS/Linux.');
const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-native-')));
try {
  const repository = join(root, 'example');
  const home = join(root, 'empty-home');
  const otherRepository = join(root, 'other-worktree');
  await mkdir(repository);
  await mkdir(home);
  await mkdir(otherRepository);
  await writeFile(join(otherRepository, 'README.md'), 'UNREGISTERED_MUST_NOT_BE_READ');
  await writeFile(join(repository, 'README.md'), 'registered repository');
  await writeFile(join(repository, '.env'), 'FAKE_SECRET_MUST_NOT_BE_READ');
  await writeFile(join(root, 'outside.txt'), 'UNREGISTERED_MUST_NOT_BE_READ');
  const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home };
  let options = codexOptions(repository, env);
  const overrides: string[] = [];
  function flatten(value: unknown, prefix: string) {
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, child] of Object.entries(value))
        flatten(child, prefix ? `${prefix}.${key}` : key);
    else overrides.push(`${prefix}=${JSON.stringify(value)}`);
  }
  flatten(options.config, '');
  overrides.push(...options.configOverrides!);
  function command(executable: string, args: string[]) {
    return spawnSync(
      process.execPath,
      [
        resolve('node_modules/@openai/codex/bin/codex.js'),
        ...overrides.flatMap((value) => ['--config', value]),
        'sandbox',
        '--',
        executable,
        ...args,
      ],
      { env, cwd: repository, encoding: 'utf8', timeout: 10000 },
    );
  }
  const allowed = command('/bin/cat', [join(repository, 'README.md')]);
  assert.equal(allowed.status, 0, `Repository read failed: ${allowed.stderr}`);
  assert.equal(allowed.stdout.trim(), 'registered repository');
  for (const file of [
    join(root, 'outside.txt'),
    join(repository, '.env'),
    join(otherRepository, 'README.md'),
  ]) {
    const denied = command('/bin/cat', [file]);
    assert.notEqual(denied.status, 0, 'Out-of-bound read unexpectedly allowed');
    assert.doesNotMatch(denied.stdout, /MUST_NOT_BE_READ/);
  }
  const write = command('/usr/bin/touch', [join(repository, 'must-not-exist')]);
  assert.notEqual(write.status, 0, 'Read-only repository unexpectedly writable');
  await assert.rejects(readFile(join(repository, 'must-not-exist')));
  options = codexOptions(repository, env, undefined, true);
  overrides.length = 0;
  flatten(options.config, '');
  overrides.push(...options.configOverrides!);
  const isolatedWrite = command('/usr/bin/touch', [join(repository, 'allowed-write')]);
  assert.equal(isolatedWrite.status, 0, `Isolated write failed: ${isolatedWrite.stderr}`);
  await readFile(join(repository, 'allowed-write'));
  for (const file of [
    join(otherRepository, 'forbidden-write'),
    join(repository, '.env'),
    join(root, 'outside.txt'),
  ]) {
    const denied = command('/usr/bin/touch', [file]);
    assert.notEqual(denied.status, 0, `Out-of-bound write allowed: ${file}`);
  }
  await mkdir(join(repository, '.git'));
  const metadataWrite = command('/usr/bin/touch', [join(repository, '.git', 'config')]);
  assert.notEqual(metadataWrite.status, 0, 'Git metadata write unexpectedly allowed');
  console.log(
    'Native sandbox passed: repository read allowed; outside/secret/other-worktree reads and repository writes denied; write profile permits worktree writes and denies sibling/secret/Git metadata writes. No credentials or model calls used.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
