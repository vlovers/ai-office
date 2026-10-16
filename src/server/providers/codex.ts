import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { ThreadEvent } from '@openai/codex-sdk';
import type { AgentProvider, ProviderEvent, ProviderSession } from './types.js';
import type { SessionBinding } from './types.js';
import type { CodexAuth, CodexExecution } from './codex-auth.js';
import { codexDiagnostic } from './codex-diagnostics.js';

class EventQueue implements AsyncIterable<ProviderEvent> {
  private values: ProviderEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: ProviderEvent) {
    this.values.push(value);
    this.wake?.();
  }
  close() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.values.length) {
      const next = this.values.shift();
      if (next) yield next;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
interface Run {
  child: ChildProcess;
  queue: EventQueue;
  closed: Promise<void>;
  stopping: boolean;
}
export interface CodexProviderOptions {
  home: string;
  auth: CodexAuth;
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly capabilities = { cancellation: true, interactiveApprovals: false, writes: false };
  private runs = new Map<string, Run>();
  private prepared = new Map<string, CodexExecution>();
  constructor(private options: CodexProviderOptions) {}
  async startSession(repositoryPath: string): Promise<ProviderSession> {
    const execution = await this.options.auth.prepare();
    const session = {
      id: randomUUID(),
      repositoryPath,
      threadId: null,
      binding: execution.binding,
    };
    this.prepared.set(session.id, execution);
    return session;
  }
  async resumeSession(
    repositoryPath: string,
    threadId: string,
    binding?: SessionBinding,
  ): Promise<ProviderSession> {
    if (!binding)
      throw new Error('Legacy session has no verified connection context. Start a new session.');
    const execution = await this.options.auth.prepare(binding);
    const session = { id: randomUUID(), repositoryPath, threadId, binding: execution.binding };
    this.prepared.set(session.id, execution);
    return session;
  }
  async executeTask(session: ProviderSession, prompt: string) {
    if (this.runs.size) throw new Error('Codex already has an active task.');
    if (process.platform === 'win32')
      throw new Error('AI Office requires macOS or Linux process groups. Windows is unsupported.');
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    const execution = this.prepared.get(session.id);
    if (!execution) throw new Error('Session has no prepared connection.');
    this.prepared.delete(session.id);
    const worker = new URL(
      import.meta.url.endsWith('.ts') ? './codex-worker.ts' : './codex-worker.js',
      import.meta.url,
    );
    const child = fork(worker, [], {
      detached: true,
      execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: this.options.home,
        CODEX_HOME: this.options.home,
      },
    });
    const queue = new EventQueue();
    let completed = false;
    let finalResponse = '';
    let failed = false;
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const run: Run = { child, queue, closed, stopping: false };
    this.runs.set(session.id, run);
    child.on(
      'message',
      (message: {
        type: string;
        event?: ThreadEvent;
        message?: string;
        category?: 'authentication' | 'connection' | 'provider';
      }) => {
        if (message.type === 'failure') {
          failed = true;
          queue.push({
            kind: 'failure',
            message: message.message ?? 'Codex worker failed.',
            category: message.category,
          });
        }
        const event = message.event;
        if (message.type !== 'sdk' || !event) return;
        if (event.type === 'thread.started') {
          session.threadId = event.thread_id;
          queue.push({ kind: 'thread', threadId: event.thread_id });
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          failed = true;
          queue.push({
            kind: 'failure',
            ...codexDiagnostic(event.type === 'error' ? event.message : event.error.message),
          });
        } else if (event.type === 'turn.completed') {
          completed = true;
          if (finalResponse) queue.push({ kind: 'result', text: finalResponse });
          queue.push({ kind: 'progress', message: 'Turn completed.', data: event });
        } else if ('item' in event) {
          const item = event.item;
          if (event.type === 'item.completed' && item.type === 'agent_message')
            finalResponse = item.text;
          queue.push({
            kind: 'progress',
            message:
              item.type === 'command_execution'
                ? `${item.command}\n${item.aggregated_output}`
                : 'text' in item
                  ? item.text
                  : item.type,
            data: event,
          });
        } else queue.push({ kind: 'progress', message: event.type, data: event });
      },
    );
    child.on('error', () => {
      failed = true;
      queue.push({ kind: 'failure', message: 'Could not start Codex worker.' });
    });
    child.on('close', (code, signal) => {
      // SDK hides its CLI PID. Reap all group members, including descendants, before unlocking.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group has exited */
        }
      }
      if (!failed && !run.stopping && (!completed || code !== 0 || signal))
        queue.push({
          kind: 'failure',
          message: !completed
            ? 'Codex exited without completing its turn.'
            : 'Codex worker terminated abnormally after its turn.',
        });
      this.runs.delete(session.id);
      queue.close();
      close();
    });
    child.send(
      {
        type: 'run',
        repositoryPath: session.repositoryPath,
        threadId: session.threadId,
        prompt,
        executable: execution.executable,
        cliEnv: execution.env,
        model: execution.binding.model,
      },
      (error) => {
        if (error) {
          failed = true;
          queue.push({ kind: 'failure', message: 'Could not communicate with Codex worker.' });
          child.kill('SIGTERM');
        }
      },
    );
  }
  streamEvents(session: ProviderSession) {
    const run = this.runs.get(session.id);
    if (!run) throw new Error('Session has not been executed.');
    return run.queue;
  }
  async stopSession(session: ProviderSession) {
    this.prepared.delete(session.id);
    const run = this.runs.get(session.id);
    if (!run) return;
    run.stopping = true;
    if (run.child.connected) run.child.send({ type: 'stop' }, () => {});
    const timer = setTimeout(() => {
      if (run.child.pid) {
        try {
          process.kill(-run.child.pid, 'SIGKILL');
        } catch {
          /* exited */
        }
      }
    }, 3000);
    await run.closed;
    clearTimeout(timer);
  }
}
