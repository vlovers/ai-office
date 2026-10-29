import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runVerification } from '../../src/server/verification.js';
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
const originalCoder = store.agent('codex-1')!;
const coder = store.editAgent(originalCoder.id, originalCoder.revision, {
  ...originalCoder,
  maximumMode: 'write',
  model: 'fixture-model',
});
const reviewer = store.agent('codex-2')!;
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

const manifest = {
  cases,
  readyWorkflowId: ready.id,
  readyVersion: approvedReady.version,
  ordinaryTaskId: ordinary.id,
};
const verificationDirectory = process.argv[3];
if (verificationDirectory) {
  // Optional integration mode: keep the WAL open while a detached verification
  // supervisor runs a synthetic delayed writer. No provider or network calls.
  const command = [
    process.execPath,
    '-e',
    "const fs=require('node:fs');fs.writeFileSync('started.json',JSON.stringify({group:process.ppid}));setTimeout(()=>fs.writeFileSync('must-not-run','orphan survived backend SIGKILL'),4000);setInterval(()=>{},1000);",
  ];
  void runVerification(command, verificationDirectory, 60_000).catch((error: unknown) => {
    console.error('Verification fixture failed:', error);
    process.exit(1);
  });
  void (async () => {
    let group: number | undefined;
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        const marker: unknown = JSON.parse(
          await readFile(join(verificationDirectory, 'started.json'), 'utf8'),
        );
        if (
          marker &&
          typeof marker === 'object' &&
          'group' in marker &&
          typeof marker.group === 'number' &&
          Number.isSafeInteger(marker.group) &&
          marker.group > 1
        ) {
          group = marker.group;
          break;
        }
      } catch {
        // The worker has not yet launched the command or written its marker.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!group) throw new Error('Verification supervisor did not start in time.');
    process.send?.({ ...manifest, verificationGroup: group });
  })().catch((error: unknown) => {
    console.error('Verification fixture readiness failed:', error);
    process.exit(1);
  });
} else {
  process.send(manifest);
}
// Keep the SQLite WAL connection open until the parent sends SIGKILL.
setInterval(() => {}, 1000);
