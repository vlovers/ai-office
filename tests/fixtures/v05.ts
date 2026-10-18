import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Repository, Session, Task, Workspace, ReviewRecord } from '../../src/shared/types.js';
const at = '2026-10-18T00:00:00.000Z';
export function createV05Fixture(path: string) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./v05/schema.sql', import.meta.url), 'utf8'));
  const repository: Repository = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Synthetic v0.5',
    path: '/disposable/v05/source',
    gitDir: '/disposable/v05/source/.git',
    createdAt: at,
  };
  const workspace: Workspace = {
    id: '00000000-0000-4000-8000-000000000002',
    repositoryId: repository.id,
    path: '/disposable/v05/worktree',
    gitDir: '/disposable/v05/git',
    branch: 'ai-office/fixture',
    base: 'a'.repeat(40),
    decision: 'pending',
    identity: {
      root: 'fixture-root',
      gitDir: 'fixture-git',
      gitFile: 'fixture-pointer',
      sourceRoot: 'fixture-source',
      commonDir: 'fixture-common',
    },
  };
  const sessions: Session[] = ['codex-1', 'codex-2'].map((agentId, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 3}`,
    repositoryId: repository.id,
    provider: 'codex',
    agentId: agentId as Session['agentId'],
    threadId: `00000000-0000-4000-8000-00000000001${index}`,
    executionMode: index ? 'read-only' : 'write',
    ...(index ? {} : { workspaceId: workspace.id }),
    authMode: 'local-cli-chatgpt',
    model: 'fixture-model',
    createdAt: at,
  }));
  const tasks: Task[] = ['running', 'queued', 'completed', 'failed'].map((state, index) => ({
    id: `00000000-0000-4000-8000-00000000002${index}`,
    repositoryId: repository.id,
    agentId: index === 1 ? 'codex-2' : 'codex-1',
    sessionId: index === 1 ? null : sessions[0]!.id,
    title: `v05 ${state}`,
    prompt: 'Synthetic persisted task',
    executionMode: index === 1 ? 'read-only' : 'write',
    ...(index === 1 ? {} : { workspaceId: workspace.id }),
    state: state as Task['state'],
    result: index === 2 ? 'Synthetic completed result' : '',
    error: index === 3 ? 'Synthetic interrupted provider' : null,
    changedFiles: [],
    baselineFiles: [],
    summaryError: null,
    createdAt: at,
    updatedAt: at,
    ...(index === 3
      ? {
          reviewRequest: {
            revision: 'b'.repeat(64),
            sessionId: sessions[0]!.id,
            threadId: sessions[0]!.threadId!,
          },
        }
      : {}),
  }));
  const review: ReviewRecord = {
    workspaceId: workspace.id,
    taskId: tasks[2]!.id,
    revision: 'b'.repeat(64),
    number: 1,
    createdAt: at,
    files: [
      {
        path: 'README.md',
        status: 'M',
        availability: 'text',
        patch: '@@ -1 +1 @@\n-old\n+new\n',
        additions: 1,
        deletions: 1,
      },
    ],
    comments: [
      {
        id: '00000000-0000-4000-8000-000000000030',
        body: 'Retain this feedback',
        path: 'README.md',
        anchor: { side: 'new', line: 1 },
        createdAt: at,
        updatedAt: at,
      },
    ],
    version: 1,
    submittedAt: at,
    continuationTaskId: tasks[3]!.id,
    sessionId: sessions[0]!.id,
    threadId: sessions[0]!.threadId,
  };
  db.prepare('INSERT INTO repositories VALUES (?,?,?)').run(
    repository.id,
    repository.path,
    JSON.stringify(repository),
  );
  db.prepare('INSERT INTO workspaces VALUES (?,?)').run(workspace.id, JSON.stringify(workspace));
  for (const session of sessions) {
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
      session.id,
      repository.id,
      JSON.stringify(session),
    );
    db.prepare('INSERT INTO session_bindings VALUES (?,?)').run(
      session.id,
      JSON.stringify({
        mode: 'local-cli-chatgpt',
        model: 'fixture-model',
        runtimeVersion: '0.162.1',
        contextId: 'synthetic-private-binding',
      }),
    );
  }
  for (const task of tasks)
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(
      task.id,
      repository.id,
      task.state,
      JSON.stringify(task),
    );
  db.prepare('INSERT INTO task_queue VALUES (?,?,?,?,?)').run(
    42,
    tasks[1]!.id,
    sessions[1]!.id,
    'local-cli-chatgpt',
    at,
  );
  db.prepare('INSERT INTO review_records VALUES (?,?,?,?)').run(
    workspace.id,
    review.revision,
    1,
    JSON.stringify(review),
  );
  db.prepare('INSERT INTO events(task_id,at,kind,message) VALUES (?,?,?,?)').run(
    tasks[2]!.id,
    at,
    'result',
    'Retain this event',
  );
  db.close();
  return { repository, workspace, sessions, tasks, review };
}
