import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataClient, localCli } from './codex-metadata.js';
import { AppError } from '../errors.js';
import type { AuthMode, ConnectionView, ConnectionStatus } from '../../shared/types.js';
import type { SessionBinding } from './types.js';

const execute = promisify(execFile);
const supportedVersion = '0.162.1';
export interface LocalInspection {
  account: 'chatgpt' | 'apiKey' | 'other' | 'none';
  executable: string;
  env: Record<string, string>;
  version: string;
  models: { model: string; isDefault: boolean }[];
}
export interface CodexExecution {
  executable: string;
  env: Record<string, string>;
  binding: SessionBinding;
}
export interface AuthOptions {
  dataDir: string;
  apiKey?: string;
  inspectLocal?: () => Promise<LocalInspection>;
  apiExecutable?: string;
}

export async function inspectLocal(): Promise<LocalInspection> {
  const local = localCli();
  const { stdout } = await execute(local.executable, ['--version'], {
    env: local.env,
    timeout: 5000,
    maxBuffer: 1024,
  });
  const version = /^codex-cli (\S+)/.exec(stdout.trim())?.[1] ?? 'unknown';
  if (version !== supportedVersion) throw new Error('Unsupported CLI version.');
  const client = new MetadataClient(local.executable, local.env, tmpdir());
  try {
    await client.initialize();
    const account = await client.account();
    const models = account.method === 'chatgpt' ? await client.models() : [];
    return { ...local, version, account: account.method as LocalInspection['account'], models };
  } finally {
    await client.close();
  }
}
export class CodexAuth {
  private mode: AuthMode = 'local-cli-chatgpt';
  private local?: LocalInspection;
  private localStatus: ConnectionStatus = 'connection-error';
  private apiStatus: ConnectionStatus;
  private checkedAt: string | null = null;
  private pending?: Promise<ConnectionView>;
  constructor(private options: AuthOptions) {
    this.apiStatus = options.apiKey ? 'available' : 'authentication-required';
  }
  view(): ConnectionView {
    const status = this.mode === 'local-cli-chatgpt' ? this.localStatus : this.apiStatus;
    const message =
      status === 'available'
        ? this.mode === 'local-cli-chatgpt'
          ? 'Available. Uses your local ChatGPT Codex allowance/credits. Files remain read only.'
          : 'Available. API-key mode uses separate OpenAI API billing; the key is checked when the task starts.'
        : status === 'authentication-required'
          ? this.mode === 'local-cli-chatgpt'
            ? 'Authentication required. Sign in with ChatGPT using codex login in your terminal, then refresh. No API fallback.'
            : 'Authentication required. Set CODEX_API_KEY in the server environment and restart to use optional API billing.'
          : 'Connection error. Check your local Codex connection and supported CLI version, then refresh. No API fallback.';
    return {
      mode: this.mode,
      status,
      message,
      checkedAt: this.checkedAt,
      modes: [
        {
          mode: 'local-cli-chatgpt',
          label: 'Local ChatGPT login (preferred)',
          status: this.localStatus,
        },
        { mode: 'api-key', label: 'API key (separate billing)', status: this.apiStatus },
      ],
    };
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const local = await (this.options.inspectLocal ?? inspectLocal)();
        if (local.version !== supportedVersion) throw new Error('Unsupported CLI version.');
        this.local = local;
        this.localStatus = local.account === 'chatgpt' ? 'available' : 'authentication-required';
        if (this.localStatus === 'available' && !local.models.some((model) => model.isDefault))
          this.localStatus = 'connection-error';
      } catch {
        this.local = undefined;
        this.localStatus = 'connection-error';
      }
      this.apiStatus = this.options.apiKey ? 'available' : 'authentication-required';
      this.checkedAt = new Date().toISOString();
      return this.view();
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async select(mode: AuthMode) {
    this.mode = mode;
    return this.refresh();
  }
  failure(category?: string) {
    if (category !== 'authentication' && category !== 'connection') return;
    const status = category === 'authentication' ? 'authentication-required' : 'connection-error';
    if (this.mode === 'local-cli-chatgpt') this.localStatus = status;
    else this.apiStatus = status;
    this.checkedAt = new Date().toISOString();
  }
  async prepare(expected?: SessionBinding): Promise<CodexExecution> {
    const mode = this.mode; // selection cannot change while the manager owns the agent
    if (expected && expected.mode !== mode)
      throw new AppError(409, 'Choose the saved session’s connection mode before resuming.');
    if (mode === 'local-cli-chatgpt') await this.refresh();
    const connection = this.view();
    if (connection.status !== 'available') throw new AppError(503, connection.message);
    let executable: string;
    let env: Record<string, string>;
    let model: string | null;
    let version: string;
    if (mode === 'local-cli-chatgpt') {
      const local = this.local!;
      if (local.account !== 'chatgpt')
        throw new AppError(503, 'Authentication required. No API fallback.');
      executable = local.executable;
      // Rebuild the whitelist even for injected metadata transports. Never forward the whole backend env.
      env = { PATH: local.env.PATH ?? '/usr/bin:/bin' };
      if (local.env.HOME) env.HOME = local.env.HOME;
      if (local.env.CODEX_HOME) env.CODEX_HOME = local.env.CODEX_HOME;
      model = expected?.model ?? local.models.find((item) => item.isDefault)!.model;
      if (!local.models.some((item) => item.model === model))
        throw new AppError(
          409,
          'The saved session model is unavailable. Start a new session explicitly.',
        );
      version = local.version;
    } else {
      const home = join(this.options.dataDir, 'codex-home');
      await mkdir(home, { recursive: true, mode: 0o700 });
      executable =
        this.options.apiExecutable ??
        createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
      env = {
        PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
        HOME: home,
        CODEX_HOME: home,
        CODEX_API_KEY: this.options.apiKey!,
      };
      model = expected?.model ?? null;
      version = supportedVersion;
    }
    const canonicalExecutable = await realpath(executable);
    const identity = JSON.stringify([
      mode,
      canonicalExecutable,
      env.HOME,
      env.CODEX_HOME ?? join(env.HOME ?? '', '.codex'),
      version,
    ]);
    const contextId = createHash('sha256').update(identity).digest('hex');
    if (expected && (expected.contextId !== contextId || expected.runtimeVersion !== version))
      throw new AppError(
        409,
        'Saved session execution context changed. Restore its original connection or start a new session.',
      );
    const directory = join(this.options.dataDir, 'launchers');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const launcher = join(directory, `${contextId}.sh`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const temporary = `${launcher}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `#!/bin/sh\n[ "$1" = exec ] || exit 64\nshift\nexec ${quote(canonicalExecutable)} exec --ignore-user-config --ignore-rules "$@"\n`,
      { mode: 0o700 },
    );
    await rename(temporary, launcher); // atomic replacement: concurrent preflights never truncate an executable
    return {
      executable: launcher,
      env,
      binding: { mode, contextId, model, runtimeVersion: version },
    };
  }
}
