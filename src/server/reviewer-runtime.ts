import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { AppError } from './errors.js';
import { verifyReviewerSourceCandidate, type ReviewerSourceManifest } from './reviewer-source.js';

const exec = promisify(execFile);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function gitMetadataFingerprint(directory: string): Promise<string> {
  const metadata = join(directory, '.git');
  const stat = await lstat(metadata);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(409, 'Unsafe Git metadata.');
  let count = 0;
  const hash = createHash('sha256');
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (++count > 10000 || entry.isSymbolicLink())
        throw new AppError(409, 'Unsafe Git metadata entry.');
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else if (!entry.isFile()) throw new AppError(409, 'Unsupported Git metadata entry.');
      else {
        const file = join(path, entry.name);
        const info = await lstat(file, { bigint: true });
        if (info.size > 32n * 1024n * 1024n) throw new AppError(409, 'Oversized Git metadata.');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          hash.update(
            JSON.stringify([file, String(info.dev), String(info.ino), String(info.birthtimeNs)]),
          );
          hash.update(await readFile(handle));
        } finally {
          await handle.close();
        }
      }
    }
  };
  await walk(metadata);
  for (const forbidden of ['commondir', 'objects/info/alternates', 'config.worktree']) {
    try {
      await lstat(join(metadata, forbidden));
      throw new AppError(409, 'External or overridden Git metadata is prohibited.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const config = join(metadata, 'config');
  const handle = await open(config, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await readFile(handle);
    if (bytes.length > 64 * 1024) throw new AppError(409, 'Oversized Git config.');
    return hash.update(bytes).digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Git-context staging for a verified source candidate, not agent execution.
 * A local repository is initialized without a remote, external objects,
 * hooks, filters or inherited global Git configuration.
 * Caller must hold Review Center's repository lease throughout preparation.
 */
export async function stageReviewerGitContext(input: {
  sourceDirectory: string;
  manifest: ReviewerSourceManifest;
  destinationRoot: string;
  verifyRevision: () => Promise<string>;
}): Promise<{ directory: string; commit: string; sourceDigest: string }> {
  if (!(await verifyReviewerSourceCandidate(input.sourceDirectory, input.manifest)))
    throw new AppError(409, 'Reviewer source integrity verification failed.');
  if ((await input.verifyRevision()) !== input.manifest.revision)
    throw new AppError(409, 'Approved Coder revision changed.');
  const parent = await lstat(input.destinationRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new AppError(403, 'Unsafe Reviewer runtime root.');
  const directory = join(input.destinationRoot, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const runGit = async (args: string[]) =>
    (
      await exec('/usr/bin/git', ['-C', directory, ...args], {
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
      })
    ).stdout.trim();
  try {
    for (const entry of input.manifest.files) {
      const target = resolve(directory, entry.path);
      if (!target.startsWith(directory + sep))
        throw new AppError(403, 'Reviewer file escapes runtime.');
      const original = join(input.sourceDirectory, entry.path);
      const handle = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        bytes = await readFile(handle);
      } finally {
        await handle.close();
      }
      if (
        bytes.length !== entry.size ||
        createHash('sha256').update(bytes).digest('hex') !== entry.sha256
      )
        throw new AppError(409, 'Reviewer source changed during runtime preparation.');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    await runGit(['init', '-q', '--template=', '--initial-branch=reviewer']);
    await runGit(['-c', 'core.hooksPath=/dev/null', 'add', '-f', '--all']);
    await runGit([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=AI Office',
      '-c',
      'user.email=reviewer@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Verified reviewer source',
    ]);
    const commit = await runGit(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new AppError(409, 'Invalid staged Git commit.');
    if ((await runGit(['status', '--porcelain'])).length)
      throw new AppError(409, 'Reviewer runtime is not clean.');
    if (!(await verifyReviewerSourceCandidate(input.sourceDirectory, input.manifest)))
      throw new AppError(409, 'Reviewer source changed while staging.');
    if ((await input.verifyRevision()) !== input.manifest.revision)
      throw new AppError(409, 'Coder revision changed during staging.');
    const files = (await runGit(['ls-files', '-z'])).split('\0').filter(Boolean).sort();
    if (
      JSON.stringify(files) !== JSON.stringify(input.manifest.files.map((item) => item.path).sort())
    )
      throw new AppError(409, 'Runtime Git inventory mismatch.');
    const configDigest = await gitMetadataFingerprint(directory);
    // Metadata is intentionally never an execution grant.
    await writeFile(
      join(input.destinationRoot, basename(directory) + '.provenance.json'),
      JSON.stringify({ commit, sourceDigest: input.manifest.digest, configDigest }),
      { flag: 'wx', mode: 0o600 },
    );
    return { directory, commit, sourceDigest: input.manifest.digest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Best effort cleanup of a runtime created by stageReviewerGitContext. */
export async function removeReviewerGitContext(
  destinationRoot: string,
  directory: string,
): Promise<void> {
  const root = resolve(destinationRoot);
  if (!ID.test(basename(directory)) || resolve(directory) !== join(root, basename(directory)))
    throw new AppError(403, 'Refusing unsafe Reviewer runtime cleanup.');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AppError(403, 'Reviewer runtime root is unsafe.');
  await rm(directory, { recursive: true, force: true });
  await rm(join(root, basename(directory) + '.provenance.json'), { force: true });
}

/**
 * Durable, fail-closed runtime preflight. The runtime is not trusted just
 * because SQLite remembers its commit: verify its files and Git context.
 * This does not authorize an SDK execution.
 */
export async function verifyReviewerGitContext(input: {
  destinationRoot: string;
  directory: string;
  commit: string;
  manifest: ReviewerSourceManifest;
}): Promise<boolean> {
  try {
    const root = resolve(input.destinationRoot);
    const id = basename(input.directory);
    if (
      !ID.test(id) ||
      resolve(input.directory) !== join(root, id) ||
      !/^[0-9a-f]{40}$/.test(input.commit)
    )
      return false;
    const rootInfo = await lstat(root);
    const runtimeInfo = await lstat(input.directory);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !runtimeInfo.isDirectory() ||
      runtimeInfo.isSymbolicLink()
    )
      return false;
    const provenance = JSON.parse(await readFile(join(root, id + '.provenance.json'), 'utf8')) as {
      commit?: string;
      sourceDigest?: string;
      configDigest?: string;
    };
    if (
      provenance.commit !== input.commit ||
      provenance.sourceDigest !== input.manifest.digest ||
      provenance.configDigest !== (await gitMetadataFingerprint(input.directory))
    )
      return false;
    const run = async (args: string[]) =>
      (
        await exec('/usr/bin/git', ['-C', input.directory, ...args], {
          timeout: 8000,
          maxBuffer: 1024 * 1024,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: root,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_NO_REPLACE_OBJECTS: '1',
          },
        })
      ).stdout.trim();
    if ((await run(['rev-parse', 'HEAD'])) !== input.commit) return false;
    if ((await run(['remote'])).length || (await run(['status', '--porcelain'])).length)
      return false;
    const expected = input.manifest.files.map((file) => file.path).sort();
    const actual = (await run(['ls-files', '-z'])).split('\0').filter(Boolean).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
    // Reject files hidden from Git status by per-repository exclude rules.
    const allowed = new Set(expected);
    const walk = async (path: string, prefix = ''): Promise<boolean> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') {
          if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
          continue;
        }
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) {
          if (![...allowed].some((file) => file.startsWith(relative + '/'))) return false;
          if (!(await walk(join(path, entry.name), relative))) return false;
        } else if (!entry.isFile() || !allowed.has(relative)) {
          return false;
        }
      }
      return true;
    };
    if (!(await walk(input.directory))) return false;
    for (const file of input.manifest.files) {
      const path = resolve(input.directory, file.path);
      if (!path.startsWith(input.directory + sep)) return false;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return false;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (
          createHash('sha256')
            .update(await readFile(handle))
            .digest('hex') !== file.sha256
        )
          return false;
      } finally {
        await handle.close();
      }
    }
    return true;
  } catch {
    return false;
  }
}
