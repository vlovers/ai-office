import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, basename, resolve, sep } from 'node:path';
import { AppError } from './errors.js';
import type { ChangedFile } from '../shared/types.js';

const execute = promisify(execFile);
// Fixed argument vectors only. No HTTP-provided executable, flags, shell, or environment.
export async function git(path: string, args: string[]) {
  const { stdout } = await execute(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      path,
      ...args,
    ],
    {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/var/empty',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  return stdout;
}
export function assertSafePath(path: string) {
  if (!isAbsolute(path) || path.includes('\0') || path.length > 4096)
    throw new AppError(400, 'Use an absolute local repository path.');
  if (path.split(/[\\/]/).some((part) => /estima|pixel[-_ ]?office/i.test(part)))
    throw new AppError(403, 'Estima and Pixel Office repositories are excluded from Phase 1.');
}
export async function validateRepository(input: string) {
  assertSafePath(input);
  let path: string;
  try {
    path = await realpath(input);
  } catch {
    throw new AppError(400, 'Repository path does not exist.');
  }
  assertSafePath(path);
  if (!(await stat(path)).isDirectory())
    throw new AppError(400, 'Repository path must be a directory.');
  try {
    const root = await realpath((await git(path, ['rev-parse', '--show-toplevel'])).trim());
    if (root !== path)
      throw new AppError(400, 'Register the Git worktree root, not a subdirectory.');
    const gitDir = await realpath((await git(path, ['rev-parse', '--absolute-git-dir'])).trim());
    assertSafePath(gitDir);
    return { path, gitDir, name: basename(path) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      400,
      'Path must be an accessible local Git worktree (bare repositories are unsupported).',
    );
  }
}
export async function revalidateRepository(repository: { path: string; gitDir: string }) {
  const current = await validateRepository(repository.path);
  if (current.path !== repository.path || current.gitDir !== repository.gitDir)
    throw new AppError(
      409,
      'Repository identity changed. Restore its original worktree or register a new path.',
    );
  return current;
}
export async function changedFiles(path: string): Promise<ChangedFile[]> {
  const records = (
    await git(path, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ])
  ).split('\0');
  const result: ChangedFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    // Git's NUL format handles spaces and renames without shell parsing.
    const full = resolve(path, file);
    if (!full.startsWith(path + sep)) throw new AppError(400, 'Git reported an invalid file path.');
    result.push({ path: file, status: status.trim() });
    if (status.includes('R') || status.includes('C')) index++;
  }
  return result;
}
