import { fork } from 'node:child_process';
import { AppError } from './errors.js';
import { killProcessGroup, reapProcessGroup } from './process-group.js';

export interface VerificationResult {
  output: string;
  passed: boolean;
  /** Not an attested sandbox denial: spawn failure, timeout, output cap or signal. */
  incomplete?: boolean;
}
/** An IPC message is evidence only if it matches the worker's result protocol. */
function isAttestedResult(value: unknown): value is VerificationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  // Unexpected fields are not part of the worker attestation protocol.
  if (Object.keys(candidate).some((key) => !['passed', 'output', 'incomplete'].includes(key)))
    return false;
  return (
    typeof candidate.passed === 'boolean' &&
    typeof candidate.output === 'string' &&
    candidate.output.length <= 128_100 &&
    (candidate.incomplete === undefined || typeof candidate.incomplete === 'boolean') &&
    !(candidate.passed && candidate.incomplete === true)
  );
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
  if (signal?.aborted)
    return { passed: false, output: 'Verification interrupted before launch.', incomplete: true };
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
    let protocolError = false;
    let interrupted = false;
    let watchdogExpired = false;
    let cleanupError: unknown;
    child.on('message', (value: unknown) => {
      if (interrupted || protocolError || watchdogExpired) return;
      // A malformed or repeated message must never be coerced into a denial.
      // It can otherwise crash the backend (null) or overwrite a real result.
      if (result || !isAttestedResult(value)) {
        protocolError = true;
        try {
          if (child.pid) killProcessGroup(child.pid);
        } catch (error) {
          cleanupError = error;
        }
        return;
      }
      result = {
        passed: value.passed,
        output: value.output,
        ...(value.incomplete === true ? { incomplete: true } : {}),
      };
    });
    child.on('error', () => {
      startupError = true;
    });
    // Backstop for worker startup/IPC failures. The worker also owns its own bound.
    const timer = setTimeout(() => {
      // A late supervisor result cannot attest success after forced termination.
      watchdogExpired = true;
      try {
        if (child.pid) killProcessGroup(child.pid);
      } catch (error) {
        cleanupError = error;
      }
    }, timeoutMs + 5000);
    const abort = () => {
      interrupted = true;
      result = {
        passed: false,
        output: 'Verification interrupted during application shutdown.',
        incomplete: true,
      };
      try {
        if (child.pid) killProcessGroup(child.pid);
      } catch (error) {
        cleanupError = error;
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('close', async (code, exitSignal) => {
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
      if (watchdogExpired) {
        reject(new AppError(409, 'Verification supervisor exceeded its shutdown deadline.'));
        return;
      }
      if (protocolError) {
        reject(new AppError(409, 'Verification supervisor sent an invalid result.'));
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
      // The trusted worker always terminates its own detached process group
      // with SIGKILL after sending IPC. A normal exit, nonzero crash, or
      // different signal after a plausible message is not proof of cleanup.
      // Reject it even when reapProcessGroup() subsequently succeeds.
      if (code !== null || exitSignal !== 'SIGKILL') {
        reject(new AppError(409, 'Verification supervisor exited without expected group termination.'));
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
