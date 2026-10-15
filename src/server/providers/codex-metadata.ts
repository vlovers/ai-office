/** Metadata-only CLI inspection. Never opens auth/config files or requests tokens. */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

export function localCli() {
  const executable = execFileSync('/usr/bin/which', ['codex'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  }).trim();
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  return { executable, env };
}

export class MetadataClient {
  private child;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private closed: Promise<void>;
  constructor(executable: string, env: Record<string, string>, cwd: string) {
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env,
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      // We never ask for login/token methods. Unsolicited requests get no approval.
      if (message.method && message.id !== undefined) {
        this.child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'Metadata-only client: request denied.' },
          }) + '\n',
        );
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(
            `Metadata RPC failed (code ${Number(message.error.code)}); raw diagnostics withheld.`,
          ),
        );
      else pending.resolve(message.result);
    });
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        lines.close();
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Metadata CLI exited; raw diagnostics withheld.'));
        }
        this.pending.clear();
        resolve();
      }),
    );
    this.child.on('error', () => {});
    this.child.stdin.on('error', () => {});
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'ai-office-phase11', version: '0.1.1' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        explicitGatewayOauth: true,
      },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  request(
    method: 'initialize' | 'account/read' | 'model/list' | 'thread/read',
    params: unknown,
  ): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Metadata ${method} timed out.`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('Metadata transport unavailable.'));
        }
      });
    });
  }
  async account() {
    const response = (await this.request('account/read', { refreshToken: false })) as {
      account: { type: string } | null;
      requiresOpenaiAuth: boolean;
    };
    const type = response.account?.type;
    return {
      method:
        type === 'chatgpt' ? 'chatgpt' : type === 'apiKey' ? 'apiKey' : type ? 'other' : 'none',
      requiresOpenaiAuth: response.requiresOpenaiAuth,
    };
  }
  async models() {
    const response = (await this.request('model/list', { limit: 100, includeHidden: false })) as {
      data: { model: string; isDefault: boolean }[];
    };
    return response.data.map((model) => ({ model: model.model, isDefault: model.isDefault }));
  }
  async thread(id: string) {
    const response = (await this.request('thread/read', { threadId: id, includeTurns: false })) as {
      thread: {
        id: string;
        model: string | null;
        modelProvider: string;
        cwd: string;
        path: string | null;
        cliVersion: string;
        ephemeral: boolean;
      };
    };
    return response.thread;
  }
  async close() {
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (this.child.pid) {
        try {
          process.kill(-this.child.pid, 'SIGKILL');
        } catch {
          /* exited */
        }
      }
    }, 2000);
    await this.closed;
    clearTimeout(timer);
    if (this.child.pid) {
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        /* exited */
      }
    }
  }
}
