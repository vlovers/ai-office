// Independent timeout and disconnect supervision survives an abrupt backend exit.
import { spawn } from 'node:child_process';
import { killProcessGroup } from './process-group.js';
let started = false;
let ending = false;
function terminate() {
  if (ending) return;
  ending = true;
  killProcessGroup(process.pid);
}
process.on('disconnect', terminate);
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
process.on(
  'message',
  (message: {
    argv: string[];
    cwd: string;
    timeoutMs: number;
    environment?: { HOME: string; CODEX_HOME: string };
  }) => {
    if (started) return;
    started = true;
    let output = '';
    let finishing = false;
    let timer: NodeJS.Timeout;
    function finish(passed: boolean, reason = '', incomplete = false) {
      if (ending || finishing) return;
      finishing = true;
      // Do not report completion to the backend until it also observes this worker close.
      clearTimeout(timer);
      const result = {
        output: output + reason,
        passed,
        ...(incomplete ? { incomplete: true } : {}),
      };
      if (process.connected) process.send?.(result, () => terminate());
      else terminate();
      // IPC failure/blocked pipe must not extend the runtime bound.
      setTimeout(terminate, 100).unref();
    }
    const child = spawn(message.argv[0]!, message.argv.slice(1), {
      cwd: message.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // No credentials, user hooks, NODE_OPTIONS, proxies or inherited host configuration.
      env: {
        PATH: '/usr/bin:/bin',
        HOME: message.environment?.HOME ?? '/var/empty',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...(message.environment ? { CODEX_HOME: message.environment.CODEX_HOME } : {}),
      },
    });
    timer = setTimeout(
      () => finish(false, '\nExecution stopped at time/output limit.', true),
      message.timeoutMs,
    );
    const capture = (data: Buffer) => {
      output = (output + data.toString()).slice(0, 128_000);
      if (output.length >= 128_000)
        finish(false, '\nExecution stopped at time/output limit.', true);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => finish(false, '\nVerification executable could not start.', true));
    child.on('close', (code, signal) => finish(code === 0, '', code === null || signal !== null));
  },
);
