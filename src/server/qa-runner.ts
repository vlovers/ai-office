import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from './errors.js';
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
  const executable = await realpath(argv[0]!);
  const info = await stat(executable);
  if (!info.isFile()) throw new AppError(409, 'QA executable is not a file.');
  const selected = { commandId, argv: [executable, ...argv.slice(1)], timeoutMs };
  return {
    ...selected,
    digest: createHash('sha256')
      .update(
        JSON.stringify({
          ...selected,
          identity: [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs],
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
  // A cancelled queued QA must not launch even the expensive native capability
  // probes. Keep the second check: cancellation may arrive during verification.
  if (signal.aborted) return { passed: false, output: 'QA stopped before launch.' };
  await requireUnchangedQAPlan(plan);
  try {
    await verifyNativeIsolation(undefined, signal);
  } catch (error) {
    if (signal.aborted) return { passed: false, output: 'QA stopped before launch.' };
    throw error;
  }
  if (signal.aborted) return { passed: false, output: 'QA stopped before launch.' };
  await requireUnchangedQAPlan(plan);
  if (signal.aborted) return { passed: false, output: 'QA stopped before launch.' };
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-')));
  try {
    return await runVerification(
      [process.execPath, nativeCodex, ...sandboxArguments(directory, plan.argv)],
      directory,
      plan.timeoutMs,
      signal,
      { HOME: home, CODEX_HOME: home },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
