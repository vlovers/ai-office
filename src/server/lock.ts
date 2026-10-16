import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.js';

export class ResourceLockedError extends AppError {
  constructor() {
    super(
      409,
      'Resource is locked. Verify the previous AI Office/Codex processes and local lease before retrying.',
    );
  }
}

// OS-local lease shared by all AI Office instances. Unknown/stale leases fail closed.
// We do not steal leases after a crash: the user must verify old processes have exited.
export async function acquireLock(directory: string, detail: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new ResourceLockedError();
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
