import { fork } from 'node:child_process';
import { AppError } from './errors.js';
import { killProcessGroup, reapProcessGroup } from './process-group.js';

export interface VerificationResult {
  output: string;
  passed: boolean;
}
export async function runVerification(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  environment?: { HOME: string; CODEX_HOME: string },
): Promise<VerificationResult> {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new AppError(409, 'Verification requires macOS or Linux process groups.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new AppError(400, 'Verification timeout must be positive and finite.');
  if (signal?.aborted) return { passed: false, output: 'Verification interrupted before launch.' };
  return new Promise((resolve, reject) => {
    const child = fork(
      new URL(
        import.meta.url.endsWith('.ts') ? './verification-worker.ts' : './verification-worker.js',
        import.meta.url,
      ),
      [],
      {
        detached: true,
        execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' },
      },
    );
    let result: VerificationResult | undefined;
    let startupError = false;
    let interrupted = false;
    let cleanupError: unknown;
    child.on('message', (value: VerificationResult) => {
      if (!interrupted)
        result = { passed: value.passed === true, output: String(value.output).slice(0, 128_100) };
    });
    child.on('error', () => {
      startupError = true;
    });
    // Backstop for worker startup/IPC failures. The worker also owns its own bound.
    const timer = setTimeout(() => {
      try {
        if (child.pid) killProcessGroup(child.pid);
      } catch (error) {
        cleanupError = error;
      }
    }, timeoutMs + 5000);
    const abort = () => {
      interrupted = true;
      result = { passed: false, output: 'Verification interrupted during application shutdown.' };
      try {
        if (child.pid) killProcessGroup(child.pid);
      } catch (error) {
        cleanupError = error;
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('close', async () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        if (child.pid) await reapProcessGroup(child.pid);
        cleanupError = undefined;
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError) {
        reject(cleanupError);
        return;
      }
      if (startupError && !interrupted) {
        reject(new AppError(409, 'Verification supervisor could not start.'));
        return;
      }
      // An unreported worker exit is not an attested sandbox denial. In
      // particular, native capability probes must never interpret a crashed
      // supervisor as evidence that a forbidden operation was blocked.
      if (!result) {
        reject(new AppError(409, 'Verification supervisor closed without an attested result.'));
        return;
      }
      resolve(result);
    });
    child.send({ argv, cwd, timeoutMs, environment }, (error) => {
      if (error) {
        startupError = true;
        try {
          if (child.pid) killProcessGroup(child.pid);
        } catch (failure) {
          cleanupError = failure;
        }
      }
    });
  });
}
