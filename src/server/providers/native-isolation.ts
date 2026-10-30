import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  const server = createServer((_request, response) => {
    networkEscape = true;
    response.end('NETWORK_ESCAPE');
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
    // preflight latency by four; every result and side effect is still checked.
    const forbidden = [
      ['/bin/cat', join(root, 'outside.txt')],
      ['/bin/cat', join(directory, '.env')],
      // Check nested protected paths and symlink traversal at runtime, not
      // only in CI's native-sandbox smoke test.
      ['/bin/cat', join(directory, 'nested', '.git', 'config')],
      ['/bin/cat', join(directory, 'nested', '.aws', 'credentials')],
      ['/bin/cat', join(directory, 'outside-link')],
      ['/usr/bin/touch', join(directory, 'write-escape')],
      ['/usr/bin/curl', '--silent', '--max-time', '2', `http://127.0.0.1:${address.port}`],
    ];
    await assertNativeDenials(forbidden, run, [
      outsideCanary,
      secretCanary,
      gitMetadataCanary,
      nestedCredentialsCanary,
    ]);
    if (signal?.aborted) throw new Error('Native sandbox capability verification cancelled.');
    if (networkEscape) throw new Error('Network isolation failed.');
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
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}
