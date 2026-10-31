// Credential-free safety probe of the INSTALLED Codex runtime, with no model call.
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  stat,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
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
  await mkdir(join(repository, 'nested'));
  await mkdir(join(repository, 'nested', '.git'));
  await mkdir(join(repository, 'nested', '.aws'));
  await writeFile(join(repository, 'nested', '.git', 'config'), 'NESTED_METADATA_MUST_NOT_BE_READ');
  await writeFile(
    join(repository, 'nested', '.aws', 'credentials'),
    'NESTED_SECRET_MUST_NOT_BE_READ',
  );
  await symlink(join(root, 'outside.txt'), join(repository, 'outside-link'));

  let sandboxPath = repository;
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
      { env, cwd: sandboxPath, encoding: 'utf8', timeout: 10000 },
    );
  }
  const allowed = command('/bin/cat', [join(repository, 'README.md')]);
  assert.equal(allowed.status, 0, `Repository read failed: ${allowed.stderr}`);
  assert.equal(allowed.stdout.trim(), 'registered repository');
  for (const file of [
    join(root, 'outside.txt'),
    join(repository, '.env'),
    join(otherRepository, 'README.md'),
    join(repository, 'outside-link'),
    join(repository, 'nested', '.git', 'config'),
    join(repository, 'nested', '.aws', 'credentials'),
  ]) {
    const denied = command('/bin/cat', [file]);
    assert.notEqual(denied.status, 0, `Out-of-bound read unexpectedly allowed: ${file}`);
    assert.doesNotMatch(denied.stdout, /MUST_NOT_BE_READ/);
  }
  const write = command('/usr/bin/touch', [join(repository, 'must-not-exist')]);
  assert.notEqual(write.status, 0, 'Read-only repository unexpectedly writable');
  await assert.rejects(readFile(join(repository, 'must-not-exist')));
  // Existing-file truncation is a distinct boundary from new-file creation.
  for (const [file, original] of [
    [join(repository, 'README.md'), 'registered repository'],
    [join(repository, '.env'), 'FAKE_SECRET_MUST_NOT_BE_READ'],
  ] as const) {
    const denied = command('/usr/bin/tee', [file]);
    assert.notEqual(denied.status, 0, `Read-only sandbox allowed overwrite: ${file}`);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  // A read-only profile must also prevent unlink, rename, chmod and mkdir.
  // These operations can bypass a preflight that only checks tee/touch.
  const readOnlyFile = join(repository, 'README.md');
  const originalMode = (await stat(readOnlyFile)).mode;
  for (const [executable, args] of [
    ['/bin/rm', [readOnlyFile]],
    ['/bin/mv', [readOnlyFile, join(repository, 'renamed-readme')]],
    ['/bin/chmod', ['600', readOnlyFile]],
    ['/bin/mkdir', [join(repository, 'new-directory')]],
  ] as [string, string[]][]) {
    const denied = command(executable, args);
    assert.notEqual(
      denied.status,
      0,
      `Read-only namespace/metadata mutation allowed: ${executable}`,
    );
  }
  assert.equal(await readFile(readOnlyFile, 'utf8'), 'registered repository');
  assert.equal((await stat(readOnlyFile)).mode, originalMode);
  await assert.rejects(lstat(join(repository, 'renamed-readme')));
  await assert.rejects(lstat(join(repository, 'new-directory')));
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
    join(repository, 'outside-link'),
    join(repository, 'nested', '.git', 'config'),
  ]) {
    const denied = command('/usr/bin/touch', [file]);
    assert.notEqual(denied.status, 0, `Out-of-bound write allowed: ${file}`);
  }
  const nestedCreate = command('/bin/mkdir', [join(repository, 'nested', '.codex')]);
  assert.notEqual(nestedCreate.status, 0, 'Future nested metadata directory unexpectedly writable');
  await mkdir(join(repository, '.git'));
  const metadataWrite = command('/usr/bin/touch', [join(repository, '.git', 'config')]);
  assert.notEqual(metadataWrite.status, 0, 'Git metadata write unexpectedly allowed');
  // A real linked worktree uses a Git pointer file, not a .git directory.
  const primary = join(root, 'primary');
  const linked = join(root, 'linked-worktree');
  const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync('/usr/bin/git', ['init', '-q', primary], { env: gitEnv });
  await writeFile(join(primary, 'README.md'), 'primary unchanged\n');
  execFileSync('/usr/bin/git', ['-C', primary, 'add', '.'], { env: gitEnv });
  execFileSync(
    '/usr/bin/git',
    [
      '-C',
      primary,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Fixture',
    ],
    { env: gitEnv },
  );
  execFileSync('/usr/bin/git', ['-C', primary, 'worktree', 'add', '-qb', 'isolated', linked], {
    env: gitEnv,
  });
  options = codexOptions(linked, env, undefined, true);
  overrides.length = 0;
  flatten(options.config, '');
  overrides.push(...options.configOverrides!);
  sandboxPath = linked;
  assert.equal(command('/usr/bin/touch', [join(linked, 'allowed-code-file')]).status, 0);
  for (const [executable, args] of [
    ['/bin/rm', [join(linked, '.git')]],
    ['/bin/mv', [join(linked, '.git'), join(linked, 'moved-git')]],
    ['/usr/bin/touch', [join(primary, 'must-not-write')]],
    ['/bin/cat', [join(primary, '.git', 'config')]],
  ] as [string, string[]][])
    assert.notEqual(
      command(executable, args).status,
      0,
      'Actual Git metadata or primary checkout unexpectedly accessible',
    );
  assert.match(await readFile(join(linked, '.git'), 'utf8'), /^gitdir: /);
  assert.equal(await readFile(join(primary, 'README.md'), 'utf8'), 'primary unchanged\n');
  console.log(
    'Native sandbox passed: repository read allowed; outside/secret/other-worktree reads and repository writes denied; write profile permits worktree writes and denies sibling/secret/nested metadata and symlink escapes; actual linked-worktree Git pointer deletion/rename and primary checkout access denied. No credentials or model calls used.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
