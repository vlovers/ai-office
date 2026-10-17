import { lstat, mkdir, realpath, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { Repository, Workspace, WorkspaceReview } from '../shared/types.js';
import { AppError } from './errors.js';
import { changedFiles, git, revalidateRepository, validateRepository } from './repositories.js';

export interface WorkspaceOptions {
  authorizedRoot: string;
  workspaceRoot: string;
  commands?: Record<string, string[]>;
  verificationTimeoutMs?: number;
}
const inside = (root: string, path: string) => path.startsWith(root + sep);
const secretPath = (path: string) =>
  /(^|\/)(\.env[^/]*|\.aws|\.codex|\.agents|credentials[^/]*|auth\.json)(\/|$)|\.pem$/i.test(path);
export class Workspaces {
  constructor(readonly options: WorkspaceOptions) {}
  async authorize(repository: Repository) {
    if (!isAbsolute(this.options.authorizedRoot) || !isAbsolute(this.options.workspaceRoot))
      throw new AppError(
        400,
        'Write roots must be absolute paths configured by the server operator.',
      );
    const root = await realpath(this.options.authorizedRoot);
    await revalidateRepository(repository);
    if (repository.path !== root && !inside(root, repository.path))
      throw new AppError(403, 'Repository is outside AI_OFFICE_AUTHORIZED_ROOT.');
    if (relative(root, repository.path).split(sep).includes('..'))
      throw new AppError(403, 'Repository path escapes the authorized root.');
    const workRoot = resolve(this.options.workspaceRoot);
    if (workRoot !== this.options.workspaceRoot)
      throw new AppError(403, 'Workspace root must be canonical without traversal components.');
    if (
      workRoot === repository.path ||
      inside(repository.path, workRoot) ||
      inside(workRoot, repository.path)
    )
      throw new AppError(403, 'Workspace root and primary checkout must be separate directories.');
    // Check existing ancestors before mkdir: invalid configuration must not write through a link.
    let ancestor = workRoot;
    while (true) {
      try {
        if ((await realpath(ancestor)) !== ancestor)
          throw new AppError(
            403,
            'Workspace root must be canonical and must not contain symlinks.',
          );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        ancestor = dirname(ancestor);
      }
    }
    let enclosingCheckout = false;
    try {
      await git(ancestor, ['rev-parse', '--show-toplevel']);
      enclosingCheckout = true;
    } catch {
      /* Not inside a checkout. */
    }
    if (enclosingCheckout)
      throw new AppError(403, 'Workspace root must be outside existing Git checkouts.');
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    if ((await realpath(workRoot)) !== workRoot)
      throw new AppError(403, 'Workspace root identity changed. Inspect it manually.');
    return workRoot;
  }
  async create(repository: Repository, id: string): Promise<Workspace> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError(400, 'Invalid workspace identifier.');
    const root = await this.authorize(repository);
    const path = join(root, id);
    if (
      await lstat(path).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        },
      )
    )
      throw new AppError(409, 'Workspace path already exists. Preserve it and create a new task.');
    const branch = `ai-office/${id}`;
    const refs = await git(repository.path, [
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${branch}`,
    ]);
    if (refs.trim())
      throw new AppError(409, 'Task branch already exists. Preserve it and create a new task.');
    const base = await git(repository.path, ['rev-parse', '--verify', 'HEAD']).then(
      (value) => value.trim(),
      () => {
        throw new AppError(
          409,
          'Write sessions require a repository with an initial commit. Commit your starting files first.',
        );
      },
    );
    try {
      await git(repository.path, ['worktree', 'add', '-b', branch, '--', path, base]);
    } catch {
      throw new AppError(
        409,
        'Could not create isolated worktree. Inspect Git worktrees and branch conflicts; nothing was overwritten.',
      );
    }
    const identity = await validateRepository(path);
    return {
      id,
      repositoryId: repository.id,
      path,
      gitDir: identity.gitDir,
      branch,
      base,
      decision: 'pending',
    };
  }
  async validate(repository: Repository, workspace: Workspace) {
    const root = await this.authorize(repository);
    if (
      workspace.repositoryId !== repository.id ||
      workspace.path !== join(root, workspace.id) ||
      workspace.branch !== `ai-office/${workspace.id}` ||
      workspace.decision === 'rejected'
    )
      throw new AppError(409, 'Workspace ownership or state does not match. Inspect it manually.');
    const info = await lstat(workspace.path).catch(() => {
      throw new AppError(
        409,
        'Saved worktree is missing or inaccessible. Restore it or inspect manually.',
      );
    });
    if (info.isSymbolicLink()) throw new AppError(403, 'Workspace symlinks are forbidden.');
    await revalidateRepository(workspace);
    const common = async (path: string) =>
      realpath(
        (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
      );
    if (
      (await common(workspace.path)) !== (await common(repository.path)) ||
      (
        await git(workspace.path, ['symbolic-ref', '--short', 'HEAD']).catch(() => {
          throw new AppError(409, 'Workspace branch changed or detached. Inspect it manually.');
        })
      ).trim() !== workspace.branch
    )
      throw new AppError(409, 'Workspace Git identity changed. Inspect it manually.');
  }
  async review(repository: Repository, workspace: Workspace): Promise<WorkspaceReview> {
    await this.validate(repository, workspace);
    const files = new Map((await changedFiles(workspace.path)).map((file) => [file.path, file]));
    const records = (
      await git(workspace.path, [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        workspace.base,
        '--',
      ])
    ).split('\0');
    for (let i = 0; i + 1 < records.length; i += 2)
      if (records[i]) files.set(records[i + 1]!, { path: records[i + 1]!, status: records[i]! });
    if (files.size > 500)
      throw new AppError(413, 'More than 500 changed files. Review this worktree manually.');
    let diff = '';
    for (const file of files.values()) {
      if (secretPath(file.path)) {
        diff += `\n${file.path}: sensitive path; inspect locally.\n`;
        continue;
      }
      if (diff.length > 512_000) {
        diff += '\nDiff truncated; inspect remaining changes locally.\n';
        break;
      }
      diff += await git(workspace.path, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        workspace.base,
        '--',
        file.path,
      ]).catch(() => `\n${file.path}: diff unavailable or exceeds limits; inspect locally.\n`);
      if (file.status === '??') {
        const path = resolve(workspace.path, file.path);
        if (!inside(workspace.path, path)) throw new AppError(403, 'Invalid changed-file path.');
        const info = await lstat(path);
        // Never follow an untracked symlink (including a symlinked parent).
        if (info.isFile() && info.size <= 256_000 && (await realpath(path)) === path) {
          const data = await readFile(path);
          diff +=
            `\n--- /dev/null\n+++ b/${file.path}\n` +
            (data.includes(0)
              ? 'Binary file\n'
              : data
                  .toString('utf8')
                  .split('\n')
                  .map((line) => `+${line}`)
                  .join('\n'));
        } else diff += `\n${file.path}: large file, directory or symlink; inspect locally.\n`;
      }
      if (diff.length > 512_000) {
        diff = diff.slice(0, 512_000) + '\nDiff truncated; inspect remaining changes locally.\n';
        break;
      }
    }
    return {
      workspace,
      files: [...files.values()],
      diff,
      commands: Object.keys(this.options.commands ?? {}),
    };
  }
  async reject(repository: Repository, workspace: Workspace) {
    await this.validate(repository, workspace);
    if (workspace.decision !== 'pending')
      throw new AppError(
        409,
        'Only pending proposals can be rejected. Kept changes require manual cleanup.',
      );
    if ((await git(workspace.path, ['rev-parse', 'HEAD'])).trim() !== workspace.base)
      throw new AppError(409, 'Workspace contains commits. Preserve them and clean up manually.');
    const directories = [workspace.path];
    let entriesSeen = 0;
    while (directories.length) {
      const directory = directories.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entriesSeen > 50_000)
          throw new AppError(409, 'Large worktree requires manual cleanup (ownership scan limit).');
        if (entry.name === '.git') {
          if (directory !== workspace.path)
            throw new AppError(
              409,
              'Nested Git repository detected. Preserve it and clean up manually.',
            );
          continue;
        }
        if (entry.isDirectory()) directories.push(join(directory, entry.name));
      }
    }
    try {
      // Git removes only this registered worktree; never recursively delete an arbitrary path.
      await git(repository.path, ['worktree', 'remove', '--force', '--', workspace.path]);
    } catch {
      throw new AppError(
        409,
        'Cleanup failed or was incomplete. Branch retained; inspect remaining worktree files manually.',
      );
    }
    return { ...workspace, decision: 'rejected' as const };
  }
  async verify(repository: Repository, workspace: Workspace, name: string) {
    await this.validate(repository, workspace);
    const argv = this.options.commands?.[name];
    if (!argv?.length || !isAbsolute(argv[0]!))
      throw new AppError(
        400,
        'Choose a server-configured verification command with an absolute executable.',
      );
    const result = await new Promise<{ output: string; passed: boolean }>((done, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: workspace.path,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/var/empty',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      let output = '';
      let bounded = false;
      const kill = () => {
        bounded = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* exited */
          }
        }
      };
      const timer = setTimeout(
        kill,
        Math.min(this.options.verificationTimeoutMs ?? 60_000, 120_000),
      );
      const capture = (data: Buffer) => {
        output = (output + data.toString()).slice(0, 128_000);
        if (output.length >= 128_000) kill();
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new AppError(409, 'Verification executable could not start.'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* exited */
          }
        }
        done({
          output: output + (bounded ? '\nExecution stopped at time/output limit.' : ''),
          passed: code === 0 && !bounded,
        });
      });
    });
    return {
      ...workspace,
      verification: { command: name, ...result, at: new Date().toISOString() },
    };
  }
}
