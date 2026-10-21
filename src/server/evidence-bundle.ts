import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ReviewFile } from '../shared/types.js';
import { AppError } from './errors.js';
import { assessHandoff } from './handoff-assessment.js';

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;

export interface SnapshotManifest {
  id: string;
  evidenceRevision: string;
  digest: string;
  createdAt: string;
  entries: { path: string; status: string; sha256: string | null; size: number }[];
}

/**
 * Writes a changed-file evidence bundle only. This deliberately does not
 * claim to be an immutable or runnable Reviewer workspace.
 *
 * Caller MUST hold Review Center's repository/worktree leases across
 * pre- and post-capture fingerprint verification and this entire call.
 */
export async function materializeEvidenceBundle(input: {
  workspacePath: string;
  destinationRoot: string;
  files: readonly ReviewFile[];
  evidenceRevision: string;
  verifyRevision: () => Promise<string>;
}): Promise<{ path: string; manifest: SnapshotManifest }> {
  const assessment = assessHandoff(input.files);
  if (!assessment.eligible) throw new AppError(409, 'Handoff manifest is unsafe.');
  if (!/^[a-f0-9]{64}$/i.test(input.evidenceRevision))
    throw new AppError(400, 'Invalid evidence revision.');
  const pre = await input.verifyRevision();
  if (pre !== input.evidenceRevision) throw new AppError(409, 'Evidence changed before capture.');
  const rootInfo = await lstat(input.destinationRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new AppError(403, 'Unsafe evidence destination root.');
  const directory = join(input.destinationRoot, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  try {
    let total = 0;
    const entries: SnapshotManifest['entries'] = [];
    for (const file of input.files) {
      if (file.status === 'D') {
        entries.push({ path: file.path, status: file.status, sha256: null, size: 0 });
        continue;
      }
      const source = resolve(input.workspacePath, file.path);
      if (!source.startsWith(input.workspacePath + sep))
        throw new AppError(403, 'File escapes workspace.');
      const parts = file.path.split('/');
      let current = input.workspacePath;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        const parent = await lstat(current);
        if (!parent.isDirectory() || parent.isSymbolicLink())
          throw new AppError(409, 'Unsafe parent directory.');
      }
      const before = await lstat(source);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE)
        throw new AppError(409, 'Unsupported or oversized evidence file.');
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (
          opened.ino !== before.ino ||
          opened.dev !== before.dev ||
          opened.size !== before.size ||
          opened.mtimeMs !== before.mtimeMs ||
          opened.ctimeMs !== before.ctimeMs
        )
          throw new AppError(409, 'Evidence file changed during open.');
        bytes = await readFile(handle);
        const after = await handle.stat();
        if (
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new AppError(409, 'Evidence file changed during read.');
      } finally {
        await handle.close();
      }
      total += bytes.length;
      if (total > MAX_TOTAL || bytes.length > MAX_FILE)
        throw new AppError(413, 'Evidence bundle exceeds limits.');
      const destination = join(directory, file.path);
      const targetParent = destination.slice(0, destination.lastIndexOf('/'));
      await mkdir(targetParent, { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
      entries.push({
        path: file.path,
        status: file.status,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
    }
    if ((await input.verifyRevision()) !== input.evidenceRevision)
      throw new AppError(409, 'Evidence changed during capture.');
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    const manifest: SnapshotManifest = {
      id: directory.split('/').at(-1)!,
      evidenceRevision: input.evidenceRevision,
      digest,
      createdAt: new Date().toISOString(),
      entries,
    };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), {
      flag: 'wx',
      mode: 0o400,
    });
    await chmod(directory, 0o500);
    return { path: directory, manifest };
  } catch (error) {
    await removeEvidenceBundle(input.destinationRoot, directory);
    throw error;
  }
}

/**
 * Deletes only a UUID-named bundle directly below the configured root.
 * The caller must ensure the directory is not in use by another process.
 */
export async function removeEvidenceBundle(root: string, directory: string): Promise<void> {
  if (
    dirname(directory) !== root ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      directory.slice(root.length + 1),
    )
  )
    throw new AppError(403, 'Refusing to remove a non-bundle directory.');
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AppError(403, 'Bundle identity is unsafe; inspect manually.');
  const unseal = async (path: string): Promise<void> => {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink())
      throw new AppError(403, 'Unsafe nested bundle directory.');
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await unseal(join(path, entry.name));
    }
  };
  await unseal(directory);
  await rm(directory, { recursive: true, force: true });
}

/** Re-hash every captured byte; detecting corruption is not immutable storage. */
export async function verifyEvidenceBundle(
  path: string,
  manifest: SnapshotManifest,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(manifest.digest)) return false;
  const root = await lstat(path).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  if (manifest.id !== path.slice(path.lastIndexOf('/') + 1)) return false;
  if (!assessHandoff(manifest.entries).eligible) return false;
  const permitted = new Set(['manifest.json']);
  for (const entry of manifest.entries) {
    if (entry.status !== 'D') permitted.add(entry.path);
  }
  const visit = async (directory: string, prefix: string): Promise<boolean> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + child.name : child.name;
      if (child.isSymbolicLink()) return false;
      if (child.isDirectory()) {
        if (![...permitted].some((allowed) => allowed.startsWith(relative + '/'))) return false;
        if (!(await visit(join(directory, child.name), relative))) return false;
      } else if (!child.isFile() || !permitted.has(relative)) {
        return false;
      }
    }
    return true;
  };
  if (!(await visit(path, ''))) return false;
  const metadata = await readFile(join(path, 'manifest.json'), 'utf8');
  if (metadata !== JSON.stringify(manifest)) return false;
  for (const entry of manifest.entries) {
    if (!assessHandoff([{ path: entry.path, status: entry.status }]).eligible) return false;
    if (entry.status === 'D') {
      if (entry.sha256 !== null || entry.size !== 0) return false;
      continue;
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_FILE ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
      return false;
    const pathname = resolve(path, entry.path);
    if (!pathname.startsWith(path + sep)) return false;
    let parent = path;
    for (const segment of entry.path.split('/').slice(0, -1)) {
      parent = join(parent, segment);
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    const info = await lstat(pathname);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size) return false;
    const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await readFile(handle);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return false;
    } finally {
      await handle.close();
    }
  }
  return (
    createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex') === manifest.digest
  );
}
