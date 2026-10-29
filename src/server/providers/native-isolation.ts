import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
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
    await listenProbeServer(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Probe listener unavailable.');
    const env = {
      PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: home,
    };
    const run = async (argv: string[]) => {
      if (signal?.aborted) return { passed: false, output: '' };
      try {
        const result = await exec(executable, sandboxArguments(directory, argv), {
          cwd: directory,
          env,
          timeout: 10000,
          maxBuffer: 64_000,
          signal,
        });
        return { passed: true, output: result.stdout };
      } catch {
        return { passed: false, output: '' };
      }
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
      ['/usr/bin/touch', join(directory, 'write-escape')],
      ['/usr/bin/curl', '--silent', '--max-time', '2', `http://127.0.0.1:${address.port}`],
    ];
    const probes = await Promise.all(forbidden.map((argv) => run(argv)));
    if (signal?.aborted) throw new Error('Native sandbox capability verification cancelled.');
    if (probes.some((probe) => probe.passed))
      throw new Error('Sandbox allowed a forbidden operation.');
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
