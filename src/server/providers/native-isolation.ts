import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { codexOptions } from './codex-config.js';
import { AppError } from '../errors.js';
import { runVerification, type VerificationResult } from '../verification.js';
export const nativeCodex = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');

/** Bind a probe listener without retaining temporary settle callbacks. */
export function listenProbeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(0, '127.0.0.1');
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

/** A successful TCP handshake is already a network escape, even without HTTP. */
export function createNetworkProbeServer(onEscape: () => void): Server {
  const server = createServer((_request, response) => {
    onEscape();
    response.end('NETWORK_ESCAPE');
  });
  server.on('connection', (socket) => {
    onEscape();
    // A raw TCP peer may never send HTTP; do not retain an open socket while
    // waiting for the listener to close or for native preflight to finish.
    socket.destroy();
  });
  return server;
}

/** Drain listener closure before deciding whether a late connection escaped. */
export async function closeProbeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    // Do not let a permitted connection hold preflight open indefinitely.
    server.closeAllConnections();
  });
}

/** A denied command is evidence only when its supervisor completed normally. */
export async function assertNativeDenials(
  forbidden: string[][],
  run: (argv: string[]) => Promise<VerificationResult>,
  forbiddenReadCanaries: readonly string[] = [],
): Promise<void> {
  // Convert synchronous launch failures into rejections and wait for every
  // sibling supervisor before allowing the caller to tear down probe resources.
  const probes = await Promise.allSettled(
    forbidden.map((argv) => Promise.resolve().then(() => run(argv))),
  );
  if (probes.some((probe) => probe.status === 'rejected'))
    throw new Error('Native sandbox probe supervisor failed.');
  // A timeout, spawn failure, output cap or signal is not evidence that the
  // sandbox denied the operation. Only a completed nonzero exit is usable.
  if (probes.some((probe) => probe.status === 'fulfilled' && probe.value.incomplete))
    throw new Error('Native sandbox denial probe did not complete normally.');
  if (probes.some((probe) => probe.status === 'fulfilled' && probe.value.passed))
    throw new Error('Sandbox allowed a forbidden operation.');
  // A wrapper may leak file contents and then return a nonzero status. Exit
  // status alone cannot attest that forbidden reads were actually denied.
  if (
    probes.some(
      (probe) =>
        probe.status === 'fulfilled' &&
        forbiddenReadCanaries.some((canary) => probe.value.output.includes(canary)),
    )
  )
    throw new Error('Sandbox leaked forbidden read contents.');
}

/** A nonzero sandbox exit cannot prove that a forbidden write had no side effect. */
export async function assertProtectedFilesUnchanged(
  protectedFiles: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const unchanged = await Promise.all(
    protectedFiles.map(async ([path, expected]) => {
      try {
        return (await readFile(path, 'utf8')) === expected;
      } catch {
        return false;
      }
    }),
  );
  if (unchanged.some((value) => !value)) throw new Error('Sandbox modified a protected file.');
}

/** Capture file identity and metadata, not just the readable canary bytes. */
export interface ProtectedFileMetadata {
  path: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  ctimeMs: number;
  mtimeMs: number;
  linkTarget: string | null;
}

async function protectedFileMetadata(path: string): Promise<ProtectedFileMetadata> {
  const info = await lstat(path);
  return {
    path,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    nlink: info.nlink,
    ctimeMs: info.ctimeMs,
    mtimeMs: info.mtimeMs,
    linkTarget: info.isSymbolicLink() ? await readlink(path) : null,
  };
}

export async function captureProtectedMetadata(
  paths: readonly string[],
): Promise<ProtectedFileMetadata[]> {
  return Promise.all(paths.map((path) => protectedFileMetadata(path)));
}

/** A forged denial must not be able to chmod, replace or retarget protected files. */
export async function assertProtectedMetadataUnchanged(
  expected: readonly ProtectedFileMetadata[],
): Promise<void> {
  const actual = await Promise.all(
    expected.map(async ({ path }) => {
      try {
        return await protectedFileMetadata(path);
      } catch {
        return null;
      }
    }),
  );
  if (
    actual.some((state, index) => {
      const original = expected[index]!;
      return (
        !state ||
        state.dev !== original.dev ||
        state.ino !== original.ino ||
        state.mode !== original.mode ||
        state.uid !== original.uid ||
        state.gid !== original.gid ||
        state.nlink !== original.nlink ||
        state.ctimeMs !== original.ctimeMs ||
        state.mtimeMs !== original.mtimeMs ||
        state.linkTarget !== original.linkTarget
      );
    })
  )
    throw new Error('Sandbox modified protected filesystem metadata.');
}

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
  if (signal?.aborted)
    throw new AppError(409, 'Native sandbox capability verification was cancelled.');
  if (!['darwin', 'linux'].includes(process.platform))
    throw new AppError(409, 'Native read-only sandbox is unsupported on this platform.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-policy-')));
  const directory = join(root, 'snapshot');
  const home = join(root, 'home');
  // Fresh per-invocation canaries prove that forbidden files were not exposed,
  // even when an executable masks a successful read with a failing exit code.
  const outsideCanary = `OUTSIDE_DENIED_${randomBytes(16).toString('hex')}`;
  const secretCanary = `SECRET_DENIED_${randomBytes(16).toString('hex')}`;
  const gitMetadataCanary = `GIT_METADATA_DENIED_${randomBytes(16).toString('hex')}`;
  const nestedCredentialsCanary = `NESTED_CREDENTIALS_DENIED_${randomBytes(16).toString('hex')}`;
  let networkEscape = false;
  const server = createNetworkProbeServer(() => {
    networkEscape = true;
  });
  try {
    await mkdir(directory);
    await mkdir(home);
    await writeFile(join(directory, 'allowed.txt'), 'READ_ALLOWED');
    await writeFile(join(root, 'outside.txt'), outsideCanary);
    await writeFile(join(directory, '.env'), secretCanary);
    await mkdir(join(directory, 'nested'));
    await mkdir(join(directory, 'nested', '.git'));
    await mkdir(join(directory, 'nested', '.aws'));
    await writeFile(join(directory, 'nested', '.git', 'config'), gitMetadataCanary);
    await writeFile(join(directory, 'nested', '.aws', 'credentials'), nestedCredentialsCanary);
    await symlink(join(root, 'outside.txt'), join(directory, 'outside-link'));
    const protectedMetadata = await captureProtectedMetadata([
      join(root, 'outside.txt'),
      join(directory, 'outside-link'),
      join(directory, '.env'),
      join(directory, 'nested', '.git', 'config'),
      join(directory, 'nested', '.aws', 'credentials'),
    ]);
    await listenProbeServer(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Probe listener unavailable.');
    const run = (argv: string[]) => {
      if (signal?.aborted)
        return Promise.resolve({ passed: false, output: 'Verification cancelled before launch.' });
      // A sandbox denial is a completed verification returning passed: false.
      // A rejected supervisor (startup, IPC or uncertain process cleanup) is
      // NOT evidence of denial: propagate it and fail the entire preflight.
      const command = executable === nativeCodex ? [process.execPath, executable] : [executable];
      return runVerification(
        [...command, ...sandboxArguments(directory, argv)],
        directory,
        10000,
        signal,
        { HOME: home, CODEX_HOME: home },
      );
    };
    const read = await run(['/bin/cat', join(directory, 'allowed.txt')]);
    if (!read.passed || read.output.trim() !== 'READ_ALLOWED')
      throw new Error('Read probe failed.');
    // These independent denial probes share no writable target. Run them
    // concurrently so one slow native sandbox process cannot multiply the
    // preflight latency as probe count grows; every result and side effect is still checked.
    const forbidden = [
      ['/bin/cat', join(root, 'outside.txt')],
      ['/bin/cat', join(directory, '.env')],
      // Check nested protected paths and symlink traversal at runtime, not
      // only in CI's native-sandbox smoke test.
      ['/bin/cat', join(directory, 'nested', '.git', 'config')],
      ['/bin/cat', join(directory, 'nested', '.aws', 'credentials')],
      ['/bin/cat', join(directory, 'outside-link')],
      // tee truncates a target even with empty stdin. A forged wrapper can
      // mutate protected files and then return a denial exit code.
      ['/usr/bin/tee', join(root, 'outside.txt')],
      ['/usr/bin/tee', join(directory, 'outside-link')],
      ['/usr/bin/tee', join(directory, 'nested', '.git', 'config')],
      ['/usr/bin/tee', join(directory, 'nested', '.aws', 'credentials')],
      ['/usr/bin/touch', join(directory, 'write-escape')],
      ['/usr/bin/curl', '--silent', '--max-time', '2', `http://127.0.0.1:${address.port}`],
    ];
    await assertNativeDenials(forbidden, run, [
      outsideCanary,
      secretCanary,
      gitMetadataCanary,
      nestedCredentialsCanary,
    ]);
    // A request/connection callback may be queued when the sandbox process exits.
    // Close the listener first, then inspect the complete observed escape state.
    await closeProbeServer(server);
    if (signal?.aborted) throw new Error('Native sandbox capability verification cancelled.');
    if (networkEscape) throw new Error('Network isolation failed.');
    // Verify the original canaries after every concurrent denial probe has
    // finished. This detects masked writes through direct and symlink paths.
    await assertProtectedFilesUnchanged([
      [join(root, 'outside.txt'), outsideCanary],
      [join(directory, 'outside-link'), outsideCanary],
      [join(directory, '.env'), secretCanary],
      [join(directory, 'nested', '.git', 'config'), gitMetadataCanary],
      [join(directory, 'nested', '.aws', 'credentials'), nestedCredentialsCanary],
    ]);
    await assertProtectedMetadataUnchanged(protectedMetadata);
    // Check effects as well as exit codes (a wrapper may hide its child's status).
    if (
      await readFile(join(directory, 'write-escape')).then(
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
    try {
      await closeProbeServer(server);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
