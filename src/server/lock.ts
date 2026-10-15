import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.js';

// OS-local lease shared by all AI Office instances. Unknown/stale leases fail closed.
// We do not steal leases after a crash: the user must verify old processes have exited.
export async function acquireLock(directory: string, detail: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner = 'unknown owner';
    try {
      owner = await readFile(join(directory, 'owner.json'), 'utf8');
    } catch {
      /* fail closed */
    }
    throw new AppError(
      409,
      `Resource is locked: ${detail}. Verify no previous AI Office/Codex processes remain before removing ${directory}. Owner: ${owner}`,
    );
  }
  try {
    await writeFile(
      join(directory, 'owner.json'),
      JSON.stringify({ pid: process.pid, detail, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}
