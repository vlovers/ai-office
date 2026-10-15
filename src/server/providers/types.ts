import type { AuthMode } from '../../shared/types.js';

// Non-secret execution identity. Stored server-side, never included in the dashboard payload.
export interface SessionBinding {
  mode: AuthMode;
  contextId: string;
  model: string | null;
  runtimeVersion: string;
}
export interface ProviderSession {
  id: string;
  repositoryPath: string;
  threadId: string | null;
  binding?: SessionBinding;
}
export type ProviderEvent =
  | { kind: 'thread'; threadId: string }
  | { kind: 'progress'; message: string; data?: unknown }
  | { kind: 'result'; text: string }
  | { kind: 'failure'; message: string; category?: 'authentication' | 'connection' | 'provider' };

// Provider-specific thread objects and SDK event formats never enter the scheduler.
// A future ClaudeCodeProvider implements this contract and declares its capabilities.
export interface AgentProvider {
  readonly id: string;
  readonly capabilities: { cancellation: boolean; interactiveApprovals: boolean; writes: boolean };
  startSession(repositoryPath: string): Promise<ProviderSession>;
  resumeSession(
    repositoryPath: string,
    threadId: string,
    binding?: SessionBinding,
  ): Promise<ProviderSession>;
  executeTask(session: ProviderSession, prompt: string): Promise<void>;
  streamEvents(session: ProviderSession): AsyncIterable<ProviderEvent>;
  stopSession(session: ProviderSession): Promise<void>;
}
