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
  id: string;
  repositoryId: string;
  provider: string;
  threadId: string | null;
  createdAt: string;
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
  id: string;
  repositoryId: string;
  sessionId: string | null;
  agentId: string;
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
  agent: {
    id: string;
    name: string;
    provider: string;
    state: string;
    taskId: string | null;
    canStop: boolean;
    mode: string;
  };
  ready: boolean;
  readinessMessage: string;
}
