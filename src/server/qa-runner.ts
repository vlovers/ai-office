import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from './errors.js';
import { UncertainCleanupError } from './process-group.js';
import { runVerification } from './verification.js';
import {
  nativeCodex,
  sandboxArguments,
  verifyNativeIsolation,
} from './providers/native-isolation.js';

export interface QAPlan {
  commandId: string;
  argv: string[];
  timeoutMs: number;
  digest: string;
}
export async function qaPlan(
  commandId: string,
  argv: string[] | undefined,
  timeoutMs = 60000,
): Promise<QAPlan> {
  if (
    !argv?.length ||
    argv.length > 64 ||
    argv.some((value) => value.includes('\0') || value.length > 4096) ||
    !isAbsolute(argv[0]!)
  )
    throw new AppError(409, 'QA requires a configured command with an absolute executable.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new AppError(409, 'QA timeout must be between 1 and 120000 ms.');
  // A missing, inaccessible or non-executable command must fail approval
  // deterministically rather than leaking a filesystem error as HTTP 500.
  let executable: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    executable = await realpath(argv[0]!);
    info = await stat(executable);
  } catch {
    throw new AppError(409, 'QA executable is unavailable. Configure a valid command.');
  }
  if (!info.isFile() || (info.mode & 0o111) === 0)
    throw new AppError(409, 'QA executable must be an executable file.');
  const selected = { commandId, argv: [executable, ...argv.slice(1)], timeoutMs };
  return {
    ...selected,
    digest: createHash('sha256')
      .update(
        JSON.stringify({
          ...selected,
          identity: [
            info.dev,
            info.ino,
            info.mode,
            info.uid,
            info.gid,
            info.size,
            info.mtimeMs,
            info.ctimeMs,
          ],
        }),
      )
      .digest('hex'),
  };
}

/**
 * QA approval pins the executable's file identity and the exact command.
 * Reject changed plans before expensive preflight and again after it, since
 * the executable can be replaced while native capability probes are running.
 */
async function requireUnchangedQAPlan(plan: QAPlan): Promise<void> {
  let current: QAPlan;
  try {
    current = await qaPlan(plan.commandId, plan.argv, plan.timeoutMs);
  } catch {
    throw new AppError(409, 'Approved QA command changed. Request a new approval.');
  }
  if (current.digest !== plan.digest)
    throw new AppError(409, 'Approved QA command changed. Request a new approval.');
}

/** Untrusted repository commands run INSIDE the same restrictive native policy. */
export async function runSandboxedQA(directory: string, plan: QAPlan, signal: AbortSignal) {
  const stopped = () => ({
    passed: false,
    output: 'QA stopped before launch.',
    incomplete: true,
  });
  // A cancelled queued QA must not launch even the expensive native capability
  // probes. Keep the second check: cancellation may arrive during verification.
  if (signal.aborted) return stopped();
  try {
    await requireUnchangedQAPlan(plan);
  } catch (error) {
    // Cancellation takes precedence over a concurrent executable change.
    if (signal.aborted) return stopped();
    throw error;
  }
  // File identity resolution is asynchronous: cancellation can arrive while
  // the approval digest is being revalidated, before native probes start.
  if (signal.aborted) return stopped();
  try {
    await verifyNativeIsolation(undefined, signal);
  } catch (error) {
    if (signal.aborted) return stopped();
    throw error;
  }
  if (signal.aborted) return stopped();
  // Keep the created path available for cleanup even if canonicalization fails.
  // A failed removal is uncertain cleanup, not an ordinary QA failure: the
  // workflow manager must quarantine the workspace instead of releasing it.
  const createdHome = await mkdtemp(join(tmpdir(), 'ai-office-qa-'));
  let home = createdHome;
  let outcome: Awaited<ReturnType<typeof runVerification>>;
  let initialIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  const assertHomeIdentity = async () => {
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(createdHome);
    } catch (error) {
      throw new UncertainCleanupError(error);
    }
    if (
      !initialIdentity?.isDirectory() ||
      !current.isDirectory() ||
      initialIdentity.dev !== current.dev ||
      initialIdentity.ino !== current.ino
    ) {
      throw new UncertainCleanupError(new Error('Temporary QA HOME identity changed.'));
    }
  };
  try {
    // Keep the directory identity pinned while asynchronous canonicalization
    // and approval revalidation run. A substituted symlink or directory must
    // never become the HOME passed to the verification supervisor.
    initialIdentity = await lstat(createdHome).catch((error: unknown) => {
      throw new UncertainCleanupError(error);
    });
    // A transient symlink swap can redirect realpath() and then restore the
    // original inode before lstat(). Pin the canonical result to the actual
    // temporary parent, not just the identity observed after resolution.
    const expectedHome = join(await realpath(dirname(createdHome)), basename(createdHome));
    home = await realpath(createdHome);
    if (home !== expectedHome) {
      throw new UncertainCleanupError(new Error('Temporary QA HOME canonical path changed.'));
    }
    await assertHomeIdentity();
    // Narrow the replacement window: re-check after all asynchronous setup
    // and immediately before handing the approved argv to the supervisor.
    if (signal.aborted) return stopped();
    try {
      await requireUnchangedQAPlan(plan);
    } catch (error) {
      if (signal.aborted) return stopped();
      throw error;
    }
    if (signal.aborted) return stopped();
    await assertHomeIdentity();
    if (signal.aborted) return stopped();
    outcome = await runVerification(
      [process.execPath, nativeCodex, ...sandboxArguments(directory, plan.argv)],
      directory,
      plan.timeoutMs,
      signal,
      { HOME: home, CODEX_HOME: home },
    );
  } finally {
    try {
      // A supervisor can run for minutes. Do not recursively delete a new
      // directory placed at this path during execution, or follow a symlink
      // swapped in after the pre-launch identity check. Quarantine instead.
      // An initial lstat failure means we never attested what mkdtemp created.
      // Do not blindly delete a path that may already have been substituted.
      if (!initialIdentity) {
        throw new UncertainCleanupError(new Error('Temporary QA HOME identity was not established.'));
      }
      await assertHomeIdentity();
      await rm(createdHome, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof UncertainCleanupError) throw error;
      throw new UncertainCleanupError(error);
    }
  }
  // Cancellation may arrive after the supervisor closes while isolated HOME
  // cleanup is still pending. Do not publish a stale successful QA result.
  if (signal.aborted) return stopped();
  return outcome;
}
