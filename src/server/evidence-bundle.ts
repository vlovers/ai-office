import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
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
        if (opened.ino !== before.ino || opened.dev !== before.dev)
          throw new AppError(409, 'Evidence file changed during open.');
        bytes = await readFile(handle);
        const after = await handle.stat();
        if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size)
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
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
