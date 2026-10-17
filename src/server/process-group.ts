import { AppError } from './errors.js';

export class UncertainCleanupError extends AppError {
  constructor(cause?: unknown) {
    super(
      409,
      'Process cleanup could not be confirmed. Workspace lease retained; inspect AI Office processes before manual recovery.',
    );
    this.cause = cause;
  }
}
export function killProcessGroup(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new UncertainCleanupError();
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new UncertainCleanupError(error);
  }
}

// macOS can briefly return EPERM while an exited orphan group is being reaped.
// Retry conservatively; only a delivered SIGKILL or confirmed absence is success.
export async function reapProcessGroup(pid: number, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      killProcessGroup(pid);
      return;
    } catch (error) {
      if (
        !(error instanceof UncertainCleanupError) ||
        (error.cause as NodeJS.ErrnoException)?.code !== 'EPERM' ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
