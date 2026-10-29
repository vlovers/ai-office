import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { killProcessGroup } from '../src/server/process-group.js';
import { until } from './helpers.js';

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
  verificationGroup?: number;
}

function expectRecoveredApprovalsBlocked(
  store: Store,
  workflows: WorkflowStore,
  entries: CrashManifest['cases'],
  ordinaryTaskId: string,
) {
  // A recovered workflow must never accept a stale browser action or a
  // fresh action that reuses the pre-crash approval. Check all three
  // persisted task states, not just the running case.
  for (const entry of entries) {
    const version = entry.version + 1;
    const before = workflows.get(entry.workflowId);
    const originalEvents = store.events(entry.taskId);
    const attempts = [
      // Stale tab still holds the approval version from before SIGKILL.
      () =>
        workflows.transition(entry.workflowId, entry.version, {
          type: 'start' as const,
          taskId: entry.taskId,
          revision: 'a'.repeat(40),
        }),
      // A refreshed tab cannot resurrect a blocked stage either.
      () =>
        workflows.transition(entry.workflowId, version, {
          type: 'start' as const,
          taskId: entry.taskId,
          revision: 'a'.repeat(40),
        }),
      () =>
        workflows.transition(entry.workflowId, version, {
          type: 'approve' as const,
          revision: 'a'.repeat(40),
        }),
      () =>
        workflows.transition(entry.workflowId, version, {
          type: 'finish' as const,
          taskId: entry.taskId,
          revision: 'b'.repeat(40),
          succeeded: true,
        }),
      () => workflows.bindApprovedTask(entry.workflowId, version, entry.taskId),
      () =>
        workflows.enqueueApprovedTask(
          store,
          entry.workflowId,
          version,
          entry.taskId,
          'local-cli-chatgpt',
          'a'.repeat(40),
        ),
      () =>
        workflows.approveCoderEvidence(
          entry.workflowId,
          version,
          entry.taskId,
          'b'.repeat(64),
        ),
      () =>
        workflows.approveReadOnlyResult(
          entry.workflowId,
          version,
          'reviewer',
          'b'.repeat(64),
        ),
    ];
    for (const attempt of attempts) {
      let rejection: unknown;
      try {
        attempt();
      } catch (error) {
        rejection = error;
      }
      // A TypeError or an unrelated failure is not a security boundary.
      // Every forbidden transition must fail explicitly with HTTP 409.
      expect(rejection).toMatchObject({ statusCode: 409 });
      expect(workflows.get(entry.workflowId)).toEqual(before);
      expect(store.task(entry.taskId)?.state).toBe('interrupted');
      expect(store.events(entry.taskId)).toEqual(originalEvents);
      expect(store.queue().map((item) => item.taskId)).toEqual([
        ordinaryTaskId,
      ]);
    }
  }
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
        expect(
          recovered.events(entry.taskId).filter((event) => event.kind === 'interrupted'),
        ).toHaveLength(entry.taskState === 'queued' ? 0 : 1);
        expect(task.error).toContain(
          entry.taskState === 'queued'
            ? 'manual review after server restart'
            : 'Server terminated before the task finished',
        );
      }
      expect(recovered.queue().map((entry) => entry.taskId)).toEqual([manifest.ordinaryTaskId]);
      expect(recovered.task(manifest.ordinaryTaskId)?.state).toBe('queued');

      expectRecoveredApprovalsBlocked(recovered, workflows, manifest.cases, manifest.ordinaryTaskId);
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
        expect(
          reopened.events(entry.taskId).filter((event) => event.kind === 'interrupted'),
        ).toHaveLength(entry.taskState === 'queued' ? 0 : 1);
      }
      expect(again.get(manifest.readyWorkflowId)?.version).toBe(manifest.readyVersion);
      expect(reopened.queue().map((entry) => entry.taskId)).toEqual([manifest.ordinaryTaskId]);
      expectRecoveredApprovalsBlocked(reopened, again, manifest.cases, manifest.ordinaryTaskId);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      reopened?.close();
      recovered?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(process.platform === 'win32')(
  'reconciles a SIGKILLed workflow with live verification and no orphan writes or replay',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-office-workflow-live-crash-'));
    const path = join(root, 'metadata.sqlite');
    const fixture = fileURLToPath(new URL('./fixtures/workflow-crash-child.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, path, root], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let group: number | undefined;
    let recovered: Store | undefined;
    let reopened: Store | undefined;
    try {
      const manifest = await new Promise<CrashManifest>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Live crash fixture did not become ready: ${stderr}`));
        }, 20000);
        const fail = (reason: string) => {
          clearTimeout(timer);
          reject(new Error(reason));
        };
        child.once('message', (message) => {
          clearTimeout(timer);
          resolve(message as CrashManifest);
        });
        child.once('error', (error) => fail(`Live crash fixture failed: ${error}`));
        child.once('exit', (code, signal) =>
          fail(`Live crash fixture exited before SIGKILL: ${code}/${signal}: ${stderr}`),
        );
      });
      group = manifest.verificationGroup;
      if (typeof group !== 'number' || !Number.isSafeInteger(group) || group <= 1)
        throw new Error('Live verification fixture did not report a valid process group.');
      const running = manifest.cases.find((entry) => entry.taskState === 'running');
      if (!running) throw new Error('Live crash fixture has no running workflow task.');

      // The parent holds SQLite WAL open while a detached supervisor and a
      // synthetic background writer are both alive. No provider is executed.
      const exit = once(child, 'exit');
      expect(child.kill('SIGKILL')).toBe(true);
      const [code, signal] = await exit;
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');

      recovered = new Store(path);
      const workflows = new WorkflowStore(recovered.db);
      const task = recovered.task(running.taskId);
      const workflow = workflows.get(running.workflowId);
      expect(task?.state).toBe('interrupted');
      expect(workflow?.state).toBe('blocked');
      expect(workflow?.version).toBe(running.version + 1);
      expect(workflow?.stages[0]).toEqual(
        expect.objectContaining({ state: 'interrupted', taskId: running.taskId }),
      );
      expect(workflow?.stages[1]?.state).toBe('pending');
      expect(recovered.queue().some((entry) => entry.taskId === running.taskId)).toBe(false);
      expect(
        recovered.events(running.taskId).filter((event) => event.kind === 'interrupted'),
      ).toHaveLength(1);
      expectRecoveredApprovalsBlocked(recovered, workflows, manifest.cases, manifest.ordinaryTaskId);

      // The worker's IPC disconnect must terminate its entire process group,
      // not merely leave the SQLite task marked interrupted.
      await until(
        () => {
          try {
            process.kill(-group!, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
            if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
            throw error;
          }
        },
        (gone) => gone,
        10000,
      );
      await new Promise((resolve) => setTimeout(resolve, 4300));
      await expect(lstat(join(root, 'must-not-run'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // Reopening the WAL twice cannot replay the interrupted workflow or
      // duplicate its interruption event, even after the worker is gone.
      recovered.close();
      recovered = undefined;
      reopened = new Store(path);
      const again = new WorkflowStore(reopened.db);
      expect(again.get(running.workflowId)?.state).toBe('blocked');
      expect(again.get(running.workflowId)?.version).toBe(running.version + 1);
      expect(reopened.task(running.taskId)?.state).toBe('interrupted');
      expect(reopened.queue().some((entry) => entry.taskId === running.taskId)).toBe(false);
      expect(
        reopened.events(running.taskId).filter((event) => event.kind === 'interrupted'),
      ).toHaveLength(1);
      expectRecoveredApprovalsBlocked(reopened, again, manifest.cases, manifest.ordinaryTaskId);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (group) {
        try {
          killProcessGroup(group);
        } catch {
          // Assertions above report uncertain cleanup; still release test files.
        }
      }
      reopened?.close();
      recovered?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
