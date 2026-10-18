import { lstat, mkdir, realpath, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { runVerification } from './verification.js';
import type { Repository, Workspace, WorkspaceReview } from '../shared/types.js';
import { diffLines } from '../shared/diff.js';
import type { ReviewFile } from '../shared/types.js';
import { AppError } from './errors.js';
import { changedFiles, git, revalidateRepository, validateRepository } from './repositories.js';

export interface WorkspaceOptions {
  authorizedRoot: string;
  workspaceRoot: string;
  commands?: Record<string, string[]>;
  verificationTimeoutMs?: number;
  allowHostVerification?: boolean;
}
const fingerprint = async (path: string) => {
  const value = await lstat(path, { bigint: true });
  if (value.isSymbolicLink())
    throw new AppError(409, 'Workspace identity contains a symlink. Inspect manually.');
  return `${value.dev}:${value.ino}:${value.birthtimeNs}`;
};
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
    const common = await realpath(
      (
        await git(repository.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim(),
    );
    if (![repository.gitDir, common].every((path) => path === root || inside(root, path)))
      throw new AppError(
        403,
        'Repository Git metadata is outside AI_OFFICE_AUTHORIZED_ROOT. Explicitly authorize a root containing the source checkout and its common Git directory.',
      );
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
  async create(
    repository: Repository,
    id: string,
    recordIntent?: (workspace: Workspace) => void,
  ): Promise<Workspace> {
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
    const intent: Workspace = {
      id,
      repositoryId: repository.id,
      path,
      gitDir: '',
      branch,
      base,
      decision: 'pending',
      operation: 'creating',
    };
    recordIntent?.(intent);
    try {
      await mkdir(path, { mode: 0o700 });
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
      identity: await this.identity(repository, { path, gitDir: identity.gitDir }),
    };
  }
  private async identity(repository: Repository, workspace: { path: string; gitDir: string }) {
    const common = (
      await git(repository.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    return {
      root: await fingerprint(workspace.path),
      gitDir: await fingerprint(workspace.gitDir),
      gitFile: await fingerprint(join(workspace.path, '.git')),
      sourceRoot: await fingerprint(repository.path),
      commonDir: await fingerprint(common),
    };
  }
  async validate(repository: Repository, workspace: Workspace) {
    if (workspace.recoveryError || workspace.operation)
      throw new AppError(
        409,
        workspace.recoveryError ??
          `Workspace operation ${workspace.operation} requires recovery. Preserve files and inspect manually.`,
      );
    const root = await this.authorize(repository);
    if (
      !/^[0-9a-f-]{36}$/.test(workspace.id) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(workspace.base) ||
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
    if (
      !workspace.identity ||
      JSON.stringify(await this.identity(repository, workspace)) !==
        JSON.stringify(workspace.identity)
    )
      throw new AppError(
        409,
        'Workspace identity is missing or changed. Preserve its files; manual recovery is required.',
      );
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
  async validateExecution(repository: Repository, workspace: Workspace) {
    await this.validate(repository, workspace);
    if ((await git(workspace.path, ['rev-parse', 'HEAD'])).trim() !== workspace.base)
      throw new AppError(
        409,
        'Workspace HEAD advanced. Preserve commits, review or integrate manually, and start a new task for further coding.',
      );
  }
  async review(repository: Repository, workspace: Workspace): Promise<WorkspaceReview> {
    await this.validate(repository, workspace);
    const revision = await this.revision(repository, workspace);
    const files = new Map((await changedFiles(workspace.path)).map((file) => [file.path, file]));
    const records = (
      await git(workspace.path, [
        'diff',
        '--name-status',
        '--no-ext-diff',
        '--no-textconv',
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
    const detailed: ReviewFile[] = [];
    for (const file of files.values()) {
      const start = diff.length;
      const detail: ReviewFile = { ...file };
      detailed.push(detail);
      if (secretPath(file.path)) {
        detail.availability = 'withheld';
        diff += `\n${file.path}: sensitive path; inspect locally.\n`;
        continue;
      }
      if (diff.length > 512_000) {
        detail.availability = 'oversized';
        continue;
      }
      diff += await git(workspace.path, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        workspace.base,
        '--',
        file.path,
      ]).catch(() => {
        detail.availability = 'unavailable';
        return '';
      });
      if (file.status === '??') {
        const path = resolve(workspace.path, file.path);
        if (!inside(workspace.path, path)) throw new AppError(403, 'Invalid changed-file path.');
        const info = await lstat(path);
        if (info.isFile() && info.size <= 256_000 && (await realpath(path)) === path) {
          // O_NOFOLLOW plus post-open identity/canonical checks avoid following replaced links.
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = await handle.stat();
            if (
              opened.ino !== info.ino ||
              opened.dev !== info.dev ||
              (await realpath(path)) !== path
            )
              throw new AppError(
                409,
                'File identity changed during review. Refresh after local edits stop.',
              );
            const buffer = Buffer.alloc(256_001);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const data = buffer.subarray(0, bytesRead);
            if (bytesRead > 256_000) detail.availability = 'oversized';
            else if (data.includes(0)) detail.availability = 'binary';
            else {
              const text = data.toString('utf8');
              const content = text.endsWith('\n')
                ? text.slice(0, -1).split('\n')
                : text
                  ? text.split('\n')
                  : [];
              diff +=
                `\n--- /dev/null\n+++ ${JSON.stringify('b/' + file.path)}\n@@ -0,0 +1,${content.length} @@\n` +
                content.map((line) => `+${line}`).join('\n') +
                (text.endsWith('\n') ? '\n' : '\n\\ No newline at end of file\n');
            }
          } finally {
            await handle.close();
          }
        } else {
          detail.availability = info.size > 256_000 ? 'oversized' : 'unavailable';
          diff += `\n${file.path}: ${detail.availability}; inspect locally.\n`;
        }
      }
      const patch = diff.slice(start);
      detail.availability ??= /^Binary files .* differ$/m.test(patch)
        ? 'binary'
        : patch.length > 256_000 || diff.length > 512_000
          ? 'oversized'
          : 'text';
      if (detail.availability === 'text') {
        detail.patch = patch;
        const lines = diffLines(patch);
        detail.additions = lines.filter((line) => line.kind === 'add').length;
        detail.deletions = lines.filter((line) => line.kind === 'delete').length;
      } else {
        diff = diff.slice(0, start) + `\n${file.path}: ${detail.availability}; inspect locally.\n`;
      }
    }
    await this.assertRevision(repository, workspace, revision);
    return {
      workspace,
      revision,
      commandDetails: this.options.allowHostVerification ? (this.options.commands ?? {}) : {},
      files: detailed,
      diff,
      commands: this.options.allowHostVerification ? Object.keys(this.options.commands ?? {}) : [],
    };
  }
  async revision(repository: Repository, workspace: Workspace) {
    await this.validate(repository, workspace);
    const hash = createHash('sha256');
    hash.update(
      JSON.stringify({
        id: workspace.id,
        reviewEpoch: workspace.reviewEpoch,
        decision: workspace.decision,
        identity: workspace.identity,
        commands: this.options.commands,
        host: this.options.allowHostVerification,
      }),
    );
    hash.update(await git(workspace.path, ['rev-parse', 'HEAD']));
    hash.update(await git(workspace.path, ['ls-files', '--stage', '-z']));
    hash.update(
      await git(workspace.path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
      ]),
    );
    const directories = [workspace.path];
    let entriesSeen = 0;
    while (directories.length) {
      const directory = directories.pop()!;
      if ((await realpath(directory)) !== directory)
        throw new AppError(409, 'Directory changed during review. Refresh after local edits stop.');
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.name === '.git' && directory === workspace.path) continue;
        if (++entriesSeen > 50_000)
          throw new AppError(409, 'Large worktree requires manual review (ownership scan limit).');
        const path = join(directory, entry.name);
        const value = await lstat(path, { bigint: true });
        hash.update(
          JSON.stringify([
            path,
            String(value.dev),
            String(value.ino),
            String(value.mode),
            String(value.size),
            String(value.mtimeNs),
            String(value.ctimeNs),
          ]),
        );
        if (value.isDirectory()) directories.push(path);
      }
    }
    return hash.digest('hex');
  }
  async assertRevision(repository: Repository, workspace: Workspace, expected?: string) {
    if (!expected || expected !== (await this.revision(repository, workspace)))
      throw new AppError(
        409,
        'Workspace or command configuration changed, or review confirmation is missing. Refresh Git review and confirm again.',
      );
  }
  async reject(
    repository: Repository,
    workspace: Workspace,
    revision?: string,
    recordIntent?: () => void,
  ) {
    await this.validate(repository, workspace);
    if (workspace.decision !== 'pending')
      throw new AppError(
        409,
        'Only pending proposals can be rejected. Kept changes require manual cleanup.',
      );
    if ((await git(workspace.path, ['rev-parse', 'HEAD'])).trim() !== workspace.base)
      throw new AppError(409, 'Workspace contains commits. Preserve them and clean up manually.');
    if (
      (await git(workspace.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
        .length
    )
      throw new AppError(
        409,
        'Worktree contains ignored files that may belong to you. Preserve them and clean up manually.',
      );
    const directories = [workspace.path];
    let entriesSeen = 0;
    while (directories.length) {
      const directory = directories.pop()!;
      if ((await realpath(directory)) !== directory)
        throw new AppError(409, 'Workspace directory identity changed during cleanup.');
      const entries = await readdir(directory, { withFileTypes: true });
      const names = new Set(entries.map((entry) => entry.name));
      if (names.has('HEAD') && names.has('objects') && (names.has('refs') || names.has('config')))
        throw new AppError(
          409,
          'Nested Git bare repository detected. Preserve it and clean up manually.',
        );
      for (const entry of entries) {
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
    await this.assertRevision(repository, workspace, revision);
    await this.validate(repository, workspace);
    recordIntent?.();
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
  async verify(
    repository: Repository,
    workspace: Workspace,
    name: string,
    recordIntent?: () => void,
    signal?: AbortSignal,
  ) {
    await this.validate(repository, workspace);
    const argv = Object.hasOwn(this.options.commands ?? {}, name)
      ? this.options.commands![name]
      : undefined;
    if (!argv?.length || !isAbsolute(argv[0]!))
      throw new AppError(
        400,
        'Choose a server-configured verification command with an absolute executable.',
      );
    if (!this.options.allowHostVerification)
      throw new AppError(
        403,
        'Host verification is disabled. Review project scripts and explicitly configure AI_OFFICE_ALLOW_HOST_VERIFICATION=1 to enable it.',
      );
    if (signal?.aborted)
      throw new AppError(503, 'Verification cancelled before execution during shutdown.');
    recordIntent?.();
    const result = await runVerification(
      argv,
      workspace.path,
      Math.min(this.options.verificationTimeoutMs ?? 60_000, 120_000),
      signal,
    );
    return {
      ...workspace,
      verification: { command: name, ...result, at: new Date().toISOString() },
    };
  }
}
