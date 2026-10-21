import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AppError } from './errors.js';
import { git } from './repositories.js';

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const forbidden =
  /(^|\/)(\.git|\.env[^/]*|\.aws|\.codex|\.agents|node_modules|credentials[^/]*|auth\.json)(\/|$)|\.pem$/i;

export interface ReviewerSourceManifest {
  revision: string;
  files: { path: string; size: number; sha256: string }[];
  digest: string;
}

/**
 * Full Git-visible source candidate. No Codex session or permission grant.
 * Caller MUST hold the repository/worktree lease throughout this operation.
 * This is not an OS-immutable snapshot or an isolation boundary.
 */
export async function createReviewerSourceCandidate(input: {
  workspace: string;
  destinationRoot: string;
  revision: string;
  verifyRevision: () => Promise<string>;
}): Promise<{ directory: string; manifest: ReviewerSourceManifest }> {
  if (!/^[a-f0-9]{64}$/i.test(input.revision)) throw new AppError(400, 'Invalid source revision.');
  if ((await input.verifyRevision()) !== input.revision)
    throw new AppError(409, 'Workspace revision changed before snapshot.');
  const rootStat = await lstat(input.destinationRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new AppError(403, 'Snapshot destination must be a real directory.');
  const visibleFiles = async () => {
    const deleted = new Set(
      (await git(input.workspace, ['ls-files', '--deleted', '-z'])).split('\0').filter(Boolean),
    );
    return (
      await git(input.workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter((name) => name && !deleted.has(name))
      .sort();
  };
  const entries = await visibleFiles();
  if (!entries.length || entries.length > MAX_FILES)
    throw new AppError(409, 'Snapshot file count is outside supported limits.');
  if (new Set(entries.map((path) => path.toLocaleLowerCase('en-US'))).size !== entries.length)
    throw new AppError(409, 'Case-insensitive source path collision.');
  const root = resolve(input.workspace);
  const directory = join(input.destinationRoot, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  try {
    const manifestFiles: ReviewerSourceManifest['files'] = [];
    let total = 0;
    for (const name of entries) {
      if (
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').some((part) => !part || part === '.' || part === '..') ||
        forbidden.test(name)
      )
        throw new AppError(409, 'Unsafe source path in Reviewer candidate.');
      const path = resolve(root, name);
      if (!path.startsWith(root + sep)) throw new AppError(403, 'Source escapes workspace.');
      const segments = name.split('/');
      let parent = root;
      for (const part of segments.slice(0, -1)) {
        parent = join(parent, part);
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new AppError(409, 'Source contains a directory symlink.');
      }
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES)
        throw new AppError(409, 'Unsupported Reviewer source file.');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size ||
          opened.mtimeMs !== before.mtimeMs ||
          opened.ctimeMs !== before.ctimeMs
        )
          throw new AppError(409, 'Source changed before reading.');
        bytes = await readFile(handle);
        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new AppError(409, 'Source changed while reading.');
      } finally {
        await handle.close();
      }
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES || bytes.length > MAX_FILE_BYTES)
        throw new AppError(413, 'Reviewer source exceeds snapshot byte limits.');
      const output = join(directory, name);
      await mkdir(join(directory, ...segments.slice(0, -1)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(output, bytes, { flag: 'wx', mode: 0o400 });
      manifestFiles.push({
        path: name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    const postEntries = await visibleFiles();
    if (
      JSON.stringify(postEntries) !== JSON.stringify(entries) ||
      (await input.verifyRevision()) !== input.revision
    )
      throw new AppError(409, 'Workspace changed while preparing Reviewer source.');
    const digest = createHash('sha256').update(JSON.stringify(manifestFiles)).digest('hex');
    const manifest: ReviewerSourceManifest = {
      revision: input.revision,
      files: manifestFiles,
      digest,
    };
    await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(manifest), {
      flag: 'wx',
      mode: 0o400,
    });
    await chmod(directory, 0o500);
    return { directory, manifest };
  } catch (error) {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A strict preflight integrity check; verification never grants execution.
 * Any unexpected file, directory, symlink or changed digest is rejected.
 */
export async function verifyReviewerSourceCandidate(
  directory: string,
  manifest: ReviewerSourceManifest,
): Promise<boolean> {
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    if (
      !/^[a-f0-9]{64}$/i.test(manifest.revision) ||
      manifest.files.length < 1 ||
      manifest.files.length > MAX_FILES ||
      createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.digest
    )
      return false;
    const expected = new Set(['source-manifest.json']);
    let size = 0;
    for (const file of manifest.files) {
      if (
        !file.path ||
        file.path.startsWith('/') ||
        file.path.includes('\\') ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        forbidden.test(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        expected.has(file.path)
      )
        return false;
      expected.add(file.path);
      size += file.size;
    }
    const paths = manifest.files.map((file) => file.path.toLocaleLowerCase('en-US'));
    if (new Set(paths).size !== paths.length) return false;
    if (
      manifest.files.some((file) => file.path.toLocaleLowerCase('en-US') === 'source-manifest.json')
    )
      return false;
    if (size > MAX_TOTAL_BYTES) return false;
    const seen = new Set<string>();
    const check = async (path: string, prefix: string): Promise<boolean> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const name = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) {
          if (![...expected].some((file) => file.startsWith(name + '/'))) return false;
          if (!(await check(join(path, entry.name), name))) return false;
        } else if (!entry.isFile() || !expected.has(name)) {
          return false;
        } else {
          seen.add(name);
        }
      }
      return true;
    };
    if (!(await check(directory, '')) || seen.size !== expected.size) return false;
    if (
      (await readFile(join(directory, 'source-manifest.json'), 'utf8')) !== JSON.stringify(manifest)
    )
      return false;
    for (const file of manifest.files) {
      const path = join(directory, file.path);
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
