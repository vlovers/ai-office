import { Store } from '../../src/server/store.js';
import { WorkflowStore } from '../../src/server/workflows.js';

// This child must be SIGKILLed by its parent without closing SQLite.
// It deliberately never starts a provider or a real QA command.
const path = process.argv[2];
if (!path || !process.send) throw new Error('Crash fixture requires a database path and IPC.');

const store = new Store(path);
const repository = store.register({
  path: '/disposable/workflow-crash-recovery',
  gitDir: '/disposable/workflow-crash-recovery/.git',
  name: 'Crash recovery fixture',
});
const coder = store.agent('codex-1')!;
const reviewer = store.agent('codex-2')!;
store.db
  .prepare('UPDATE agent_versions SET json=? WHERE agent_id=? AND revision=?')
  .run(JSON.stringify({ ...coder, maximumMode: 'write' }), coder.id, coder.revision);
const workflows = new WorkflowStore(store.db);
const baseline = 'a'.repeat(40);

function runningStage(label: string, taskState: 'queued' | 'running' | 'stopping') {
  const task = store.createTask({
    repositoryId: repository.id,
    agentId: coder.id,
    title: label,
    prompt: 'No provider must execute this task.',
    executionMode: 'write',
  });
  const created = workflows.create({
    repositoryId: repository.id,
    baselineRevision: baseline,
    stages: [
      { kind: 'coder', agentId: coder.id, agentRevision: coder.revision, mode: 'write' },
      {
        kind: 'reviewer',
        agentId: reviewer.id,
        agentRevision: reviewer.revision,
        mode: 'read-only',
      },
    ],
  });
  const approved = workflows.transition(created.id, created.version, {
    type: 'approve',
    revision: baseline,
  });
  const started = workflows.transition(created.id, approved.version, {
    type: 'start',
    taskId: task.id,
    revision: baseline,
  });
  store.enqueue(task.id, 'local-cli-chatgpt');
  if (taskState !== 'queued') {
    store.claimQueued(task.id);
    if (taskState === 'stopping') store.updateTask(task.id, { state: 'stopping' });
  }
  return { workflowId: created.id, taskId: task.id, version: started.version, taskState };
}

const cases = [
  runningStage('Queued workflow at crash', 'queued'),
  runningStage('Running workflow at crash', 'running'),
  runningStage('Stopping workflow at crash', 'stopping'),
];
const ready = workflows.create({
  repositoryId: repository.id,
  baselineRevision: baseline,
  stages: [
    { kind: 'coder', agentId: coder.id, agentRevision: coder.revision, mode: 'write' },
    {
      kind: 'reviewer',
      agentId: reviewer.id,
      agentRevision: reviewer.revision,
      mode: 'read-only',
    },
  ],
});
const approvedReady = workflows.transition(ready.id, ready.version, {
  type: 'approve',
  revision: baseline,
});
const ordinary = store.createTask({
  repositoryId: repository.id,
  agentId: reviewer.id,
  title: 'Unrelated read-only task',
  prompt: 'Must remain queued across the crash.',
  executionMode: 'read-only',
});
store.enqueue(ordinary.id, 'local-cli-chatgpt');

process.send({
  cases,
  readyWorkflowId: ready.id,
  readyVersion: approvedReady.version,
  ordinaryTaskId: ordinary.id,
});
// Keep the SQLite WAL connection open until the parent sends SIGKILL.
setInterval(() => {}, 1000);
