import { fork } from 'node:child_process';
import { AppError } from './errors.js';
import { killProcessGroup, reapProcessGroup, UncertainCleanupError } from './process-group.js';

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
    let closeObserved = false;
    let closeDeadlineExpired = false;
    let terminationRequested = false;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    // SIGKILL is not proof that Node observed the supervisor's close event.
    // A missing close must retain the workspace lease instead of hanging forever.
    const armCloseDeadline = () => {
      if (closeObserved || closeDeadline) return;
      closeDeadline = setTimeout(() => {
        if (closeObserved) return;
        closeDeadlineExpired = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(
          new UncertainCleanupError(
            new Error('Verification supervisor did not close after SIGKILL.'),
          ),
        );
      }, 1500);
    };
    // Every forced termination path must have a bounded wait for close.
    // Signal only once: an abort can race with IPC errors and with reaping,
    // when the supervisor PID may already have been recycled.
    const requestTermination = () => {
      if (closeObserved || closeDeadlineExpired || terminationRequested) return;
      terminationRequested = true;
      // Node may emit exit before close if descendants retain stdio or IPC.
      // Once exit is observed, the process-group leader PID can be recycled.
      if (child.exitCode == null && child.signalCode == null) {
        try {
          if (child.pid) killProcessGroup(child.pid);
        } catch (error) {
          cleanupError = error;
        }
      }
      armCloseDeadline();
    };
    child.on('message', (value: unknown) => {
      if (closeObserved || closeDeadlineExpired || interrupted || protocolError || watchdogExpired)
        return;
      // A malformed or repeated message must never be coerced into a denial.
      // It can otherwise crash the backend (null) or overwrite a real result.
      if (result || !isAttestedResult(value)) {
        protocolError = true;
        requestTermination();
        return;
      }
      result = {
        passed: value.passed,
        output: value.output,
        ...(value.incomplete === true ? { incomplete: true } : {}),
      };
    });
    child.on('error', () => {
      // A late child error cannot invalidate an already closed, reaping worker.
      if (closeObserved || closeDeadlineExpired) return;
      startupError = true;
      requestTermination();
    });
    // An IPC disconnect before attestation means no further trusted result
    // can arrive. Do not wait for the full execution watchdog to fail closed.
    child.on('disconnect', () => {
      if (closeObserved || closeDeadlineExpired || result) return;
      startupError = true;
      requestTermination();
    });
    // Backstop for worker startup/IPC failures. The worker also owns its own bound.
    const timer = setTimeout(() => {
      // A late supervisor result cannot attest success after forced termination.
      watchdogExpired = true;
      requestTermination();
    }, timeoutMs + 5000);
    const abort = () => {
      if (closeDeadlineExpired) return;
      interrupted = true;
      result = {
        passed: false,
        output: 'Verification interrupted during application shutdown.',
        incomplete: true,
      };
      requestTermination();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('close', async (code, exitSignal) => {
      // After the deadline the caller already has an uncertain-cleanup error.
      // Do not send another SIGKILL to a PID that may have been recycled.
      if (closeObserved || closeDeadlineExpired) return;
      closeObserved = true;
      clearTimeout(timer);
      if (closeDeadline) clearTimeout(closeDeadline);
      // Keep cancellation observable while asynchronous process-group cleanup
      // runs. Otherwise an abort during reaping can accept a stale IPC success.
      try {
        if (child.pid) await reapProcessGroup(child.pid);
        cleanupError = undefined;
      } catch (error) {
        cleanupError = error;
      } finally {
        signal?.removeEventListener('abort', abort);
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
      // An abort during process-group reaping is still a cancellation, not an
      // attested success or denial, even if IPC arrived before the abort.
      if (interrupted) {
        resolve({
          passed: false,
          output: 'Verification interrupted during application shutdown.',
          incomplete: true,
        });
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
        reject(
          new AppError(409, 'Verification supervisor exited without expected group termination.'),
        );
        return;
      }
      resolve(result);
    });
    const sendFailed = () => {
      // A late IPC callback must not invalidate a result while reaping, nor
      // signal a process group whose leader has already closed.
      if (closeDeadlineExpired || closeObserved) return;
      startupError = true;
      requestTermination();
    };
    // A synchronous IPC send failure must not reject the Promise before the
    // detached worker's close/reaping path has run. Never launch work after an
    // abort that races with fork() and listener registration.
    if (!interrupted) {
      try {
        child.send({ argv, cwd, timeoutMs, environment }, (error) => {
          if (error) sendFailed();
        });
      } catch {
        sendFailed();
      }
    }
  });
}
