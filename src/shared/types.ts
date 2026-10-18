export const AGENT_IDS = ['codex-1', 'codex-2'] as const;
export type AgentId = string;
export interface ExecutionConfiguration {
  version: 1;
  source: 'legacy' | 'profile';
  agentId: string;
  profileRevision: number;
  name: string;
  role: string;
  instructions: string;
  model: string | null;
  maximumMode: ExecutionMode;
  executionMode: ExecutionMode;
  policy: 'v05-isolation-v1';
  capability: 'codex-sdk-0.162.1';
}
export interface AgentProfile {
  id: string;
  provider: 'codex';
  name: string;
  role: string;
  description: string;
  instructions: string;
  model: string | null;
  maximumMode: ExecutionMode;
  revision: number;
  archived: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}
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
  configuration?: ExecutionConfiguration;
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
  configuration?: ExecutionConfiguration;
  reviewRequest?: { revision: string; sessionId: string; threadId: string };
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
  profiles?: AgentProfile[];
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
  reviewEpoch?: string;
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
  verification?: {
    command: string;
    output: string;
    passed: boolean;
    at: string;
    revision?: string;
  };
}
export interface WorkspaceReview {
  revision?: string;
  commandDetails?: Record<string, string[]>;
  workspace: Workspace;
  files: ReviewFile[];
  record?: ReviewRecord;
  diff: string;
  commands: string[];
}

export interface ReviewFile extends ChangedFile {
  patch?: string;
  availability?: 'text' | 'binary' | 'withheld' | 'oversized' | 'unavailable';
  additions?: number;
  deletions?: number;
}
export interface ReviewComment {
  id: string;
  body: string;
  path?: string;
  anchor?: { side: 'old' | 'new'; line: number };
  createdAt: string;
  updatedAt: string;
}
export interface ReviewRecord {
  workspaceId: string;
  taskId: string;
  revision: string;
  number: number;
  createdAt: string;
  files: ReviewFile[];
  comments: ReviewComment[];
  version: number;
  submittedAt?: string;
  continuationTaskId?: string;
  sessionId: string | null;
  threadId: string | null;
  verification?: Workspace['verification'];
}
export interface ReviewHistoryEntry extends ReviewRecord {
  continuation?: Pick<Task, 'id' | 'state' | 'error' | 'sessionId'>;
}
