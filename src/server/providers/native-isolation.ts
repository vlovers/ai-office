import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { arch, release, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { codexOptions } from './codex-config.js';
import { AppError } from '../errors.js';

const exec = promisify(execFile);
export const nativeCodex = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');

/** Identical permission table to SDK execution, without legacy --sandbox overrides. */
export function sandboxArguments(directory: string, argv: string[]): string[] {
  const options = codexOptions(directory, {});
  const values: string[] = [];
  const flatten = (value: unknown, prefix: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value))
        flatten(child, prefix ? `${prefix}.${key}` : key);
    } else values.push(`${prefix}=${JSON.stringify(value)}`);
  };
  flatten(options.config, '');
  values.push(...options.configOverrides!);
  return [...values.flatMap((value) => ['--config', value]), 'sandbox', '--', ...argv];
}

/** No credentials or inference. Failure is an execution fence, never a fallback. */
export async function verifyNativeIsolation(
  executable = nativeCodex,
  signal?: AbortSignal,
): Promise<void> {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new AppError(409, 'Native read-only sandbox is unsupported on this platform.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-policy-')));
  const directory = join(root, 'snapshot');
  const home = join(root, 'home');
  let networkEscape = false;
  const server = createServer((_request, response) => {
    networkEscape = true;
    response.end('NETWORK_ESCAPE');
  });
  try {
    await mkdir(directory);
    await mkdir(home);
    await writeFile(join(directory, 'allowed.txt'), 'READ_ALLOWED');
    await writeFile(join(root, 'outside.txt'), 'OUTSIDE_DENIED');
    await writeFile(join(directory, '.env'), 'SECRET_DENIED');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Probe listener unavailable.');
    const env = {
      PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: home,
    };
    const run = async (argv: string[]) => {
      try {
        const result = await exec(executable, sandboxArguments(directory, argv), {
          cwd: directory,
          env,
          timeout: 10000,
          maxBuffer: 64_000,
          ...(signal ? { signal } : {}),
        });
        return { passed: true, output: result.stdout };
      } catch {
        return { passed: false, output: '' };
      }
    };
    await symlink(join(root, 'outside.txt'), join(directory, 'outside-link'));
    const read = await run(['/bin/cat', join(directory, 'allowed.txt')]);
    if (!read.passed || read.output.trim() !== 'READ_ALLOWED')
      throw new Error('Read probe failed.');
    for (const argv of [
      ['/bin/cat', join(root, 'outside.txt')],
      ['/bin/cat', join(directory, 'outside-link')], // symlink out of the repository
      ['/bin/cat', join(directory, '.env')],
      ['/usr/bin/touch', join(directory, 'write-escape')],
      ['/usr/bin/touch', join(directory, '..', 'parent-escape')], // traversal out of the repository
      ['/bin/mkdir', join(directory, '.git-escape')],
      ['/usr/bin/curl', '--silent', '--max-time', '2', `http://127.0.0.1:${address.port}`],
    ]) {
      signal?.throwIfAborted();
      if ((await run(argv)).passed) throw new Error('Sandbox allowed a forbidden operation.');
    }
    if (networkEscape) throw new Error('Network isolation failed.');
    // Check effects as well as exit codes (a wrapper may hide its child's status).
    for (const effect of [
      join(directory, 'write-escape'),
      join(root, 'parent-escape'),
      join(directory, '.git-escape'),
    ])
      if (
        await lstat(effect).then(
          () => true,
          () => false,
        )
      )
        throw new Error('Write isolation failed.');
  } catch {
    throw new AppError(
      409,
      'Native sandbox capability verification failed. No downstream execution is allowed.',
    );
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

export type IsolationVerifier = (
  executable: string,
  runtimeVersion: string,
  signal: AbortSignal,
  options?: { fresh?: boolean },
) => Promise<void>;

/**
 * Identity of everything that decides whether a successful probe still applies:
 * the canonical executable and its on-disk identity, the reported runtime version,
 * the exact sandbox policy arguments, and the host OS/Node runtime.
 */
export async function isolationFingerprint(executable: string, runtimeVersion: string) {
  const canonical = await realpath(executable);
  const info = await stat(canonical);
  return createHash('sha256')
    .update(
      JSON.stringify([
        canonical,
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.mode,
        runtimeVersion,
        sandboxArguments('/ai-office-policy', []),
        process.platform,
        release(),
        arch(),
        process.version,
      ]),
    )
    .digest('hex');
}

/**
 * Success-only cache around the native probe. Failures are never cached, concurrent
 * callers for one fingerprint share a single probe, entries expire, and the
 * fingerprint is recomputed on every call so a replaced binary or changed policy
 * re-probes before execution. A caller's abort rejects only that caller.
 */
export function cachedIsolationVerifier(
  probe: (executable: string, signal?: AbortSignal) => Promise<void> = verifyNativeIsolation,
  ttlMs = 10 * 60_000,
): IsolationVerifier {
  const verified = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  return async (executable, runtimeVersion, signal, options) => {
    signal.throwIfAborted();
    let key: string;
    try {
      key = await isolationFingerprint(executable, runtimeVersion);
    } catch {
      throw new AppError(
        409,
        'Native sandbox executable could not be identified. Execution blocked.',
      );
    }
    if (!options?.fresh && (verified.get(key) ?? 0) > Date.now()) return;
    let shared = options?.fresh ? undefined : pending.get(key);
    if (!shared) {
      shared = probe(executable, options?.fresh ? signal : undefined).then(() => {
        verified.set(key, Date.now() + ttlMs);
      });
      if (!options?.fresh) {
        pending.set(key, shared);
        void shared.finally(() => pending.delete(key)).catch(() => {});
      }
    }
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AppError(409, 'Isolation verification was cancelled.'));
    });
    signal.addEventListener('abort', abort, { once: true });
    // The signal may have been aborted while the fingerprint was computed.
    if (signal.aborted) abort();
    try {
      await Promise.race([shared, aborted]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}
export const nativeIsolationVerifier = cachedIsolationVerifier();
