import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';

interface CrashManifest {
  cases: Array<{
    workflowId: string;
    taskId: string;
    version: number;
    taskState: 'queued' | 'running' | 'stopping';
  }>;
  readyWorkflowId: string;
  readyVersion: number;
  ordinaryTaskId: string;
}

it.skipIf(process.platform === 'win32')(
  'recovers real SIGKILL with open SQLite WAL without replaying approved workflow tasks',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-office-workflow-sigkill-'));
    const path = join(root, 'metadata.sqlite');
    const fixture = fileURLToPath(new URL('./fixtures/workflow-crash-child.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, path], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let recovered: Store | undefined;
    let reopened: Store | undefined;
    try {
      const manifest = await new Promise<CrashManifest>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Crash fixture did not become ready: ${stderr}`));
        }, 15000);
        child.once('message', (message) => {
          clearTimeout(timer);
          resolve(message as CrashManifest);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`Crash fixture exited before SIGKILL: ${code}/${signal}: ${stderr}`));
        });
      });
      expect(manifest.cases.map((entry) => entry.taskState)).toEqual([
        'queued',
        'running',
        'stopping',
      ]);
      const exit = once(child, 'exit');
      expect(child.kill('SIGKILL')).toBe(true);
      const [code, signal] = await exit;
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');

      // Opening Store performs task recovery and then workflow reconciliation.
      // This is a new process lifecycle, not a second SQLite connection while
      // the original process is still alive.
      recovered = new Store(path);
      const workflows = new WorkflowStore(recovered.db);
      for (const entry of manifest.cases) {
        const task = recovered.task(entry.taskId)!;
        const workflow = workflows.get(entry.workflowId)!;
        expect(task.state).toBe('interrupted');
        expect(workflow.state).toBe('blocked');
        expect(workflow.version).toBe(entry.version + 1);
        expect(workflow.stages[0]).toEqual(
          expect.objectContaining({ state: 'interrupted', taskId: entry.taskId }),
        );
        expect(workflow.stages[1]?.state).toBe('pending');
        expect(recovered.queue().some((item) => item.taskId === entry.taskId)).toBe(false);
        expect(recovered.events(entry.taskId).filter((event) => event.kind === 'interrupted')).toHaveLength(
          entry.taskState === 'queued' ? 0 : 1,
        );
        expect(task.error).toContain(
          entry.taskState === 'queued'
            ? 'manual review after server restart'
            : 'Server terminated before the task finished',
        );
      }
      expect(recovered.queue().map((entry) => entry.taskId)).toEqual([
        manifest.ordinaryTaskId,
      ]);
      expect(recovered.task(manifest.ordinaryTaskId)?.state).toBe('queued');
      expect(workflows.get(manifest.readyWorkflowId)).toEqual(
        expect.objectContaining({
          state: 'active',
          version: manifest.readyVersion,
          stages: expect.arrayContaining([expect.objectContaining({ state: 'ready' })]),
        }),
      );

      // A second restart must be idempotent: no duplicate interruption events,
      // no extra workflow version bump, and no resurrected queue entries.
      recovered.close();
      recovered = undefined;
      reopened = new Store(path);
      const again = new WorkflowStore(reopened.db);
      for (const entry of manifest.cases) {
        expect(again.get(entry.workflowId)?.version).toBe(entry.version + 1);
        expect(again.get(entry.workflowId)?.state).toBe('blocked');
        expect(reopened.task(entry.taskId)?.state).toBe('interrupted');
        expect(reopened.events(entry.taskId).filter((event) => event.kind === 'interrupted')).toHaveLength(
          entry.taskState === 'queued' ? 0 : 1,
        );
      }
      expect(again.get(manifest.readyWorkflowId)?.version).toBe(manifest.readyVersion);
      expect(reopened.queue().map((entry) => entry.taskId)).toEqual([
        manifest.ordinaryTaskId,
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      reopened?.close();
      recovered?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
