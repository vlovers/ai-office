export const AGENT_IDS = ['codex-1', 'codex-2'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type TaskState =
  'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export interface Repository {
  id: string;
  name: string;
  path: string;
  gitDir: string;
  createdAt: string;
}
export interface Session {
  executionMode?: ExecutionMode;
  workspaceId?: string;
  id: string;
  repositoryId: string;
  provider: string;
  threadId: string | null;
  createdAt: string;
  agentId?: AgentId;
  authMode?: AuthMode;
  model?: string | null;
}
export type AuthMode = 'local-cli-chatgpt' | 'api-key';
export type ConnectionStatus = 'available' | 'authentication-required' | 'connection-error';
export interface ConnectionView {
  mode: AuthMode;
  status: ConnectionStatus;
  message: string;
  checkedAt: string | null;
  modes: { mode: AuthMode; label: string; status: ConnectionStatus }[];
}
export interface ChangedFile {
  path: string;
  status: string;
}
export interface Task {
  executionMode?: ExecutionMode;
  workspaceId?: string;
  id: string;
  repositoryId: string;
  sessionId: string | null;
  agentId: AgentId;
  title: string;
  prompt: string;
  state: TaskState;
  result: string;
  error: string | null;
  changedFiles: ChangedFile[];
  baselineFiles: ChangedFile[];
  summaryError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentEvent {
  id: number;
  taskId: string;
  at: string;
  kind: string;
  message: string;
  data?: unknown;
}
export interface Dashboard {
  connection: ConnectionView;
  repositories: Repository[];
  tasks: Task[];
  sessions: Session[];
  agents: AgentView[];
  /** Compatibility view of Codex 01. New clients use agents. */
  agent: AgentView;
  queue: QueueEntry[];
  concurrency: number;
  ready: boolean;
  readinessMessage: string;
}

export interface AgentView {
  id: AgentId;
  name: string;
  provider: string;
  state: string;
  taskId: string | null;
  canStop: boolean;
  mode: string;
}
export interface QueueEntry {
  taskId: string;
  agentId: AgentId;
  order: number;
  enqueuedAt: string;
  mode: AuthMode;
  resumeSessionId: string | null;
  waitingReason?: string;
}

export type ExecutionMode = 'read-only' | 'write';
export interface Workspace {
  id: string;
  repositoryId: string;
  path: string;
  gitDir: string;
  branch: string;
  base: string;
  decision: 'pending' | 'kept' | 'rejected';
  identity?: {
    root: string;
    gitDir: string;
    gitFile: string;
    sourceRoot: string;
    commonDir: string;
  };
  operation?: 'creating' | 'rejecting' | 'verifying';
  recoveryError?: string;
  verification?: { command: string; output: string; passed: boolean; at: string };
}
export interface WorkspaceReview {
  revision?: string;
  commandDetails?: Record<string, string[]>;
  workspace: Workspace;
  files: ChangedFile[];
  diff: string;
  commands: string[];
}
