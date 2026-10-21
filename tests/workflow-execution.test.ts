import { expect, it } from 'vitest';
import { writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowFixture } from './workflow-fixture.js';
import { until } from './helpers.js';
import { Store } from '../src/server/store.js';
import { WorkflowStore } from '../src/server/workflows.js';
import {
  acquireWorkflowLease,
  validateWorkflowSnapshot,
} from '../src/server/workflow-execution.js';
const native = it.skipIf(
  process.platform !== 'darwin' && process.env.AI_OFFICE_NATIVE_TESTS !== '1',
);

native(
  'runs Coder → SDK Reviewer → native QA with separate human result gates and durable reports',
  async () => {
    const env = await workflowFixture();
    try {
      const { revision, task } = await env.prepare();
      const before = await env.get();
      const responses = await Promise.all([
        env.send('POST', env.url + '/submit-reviewer', {
          version: before.version,
          confirmed: true,
        }),
        env.send('POST', env.url + '/submit-reviewer', {
          version: before.version,
          confirmed: true,
        }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      const submitted = await env.get();
      const reviewerId = submitted.stages[1]!.taskId!;
      await until(
        () => env.store.task(reviewerId),
        (value) => ['completed', 'failed'].includes(value?.state ?? ''),
        30000,
      );
      expect(env.store.task(reviewerId)?.state, JSON.stringify(env.store.events(reviewerId))).toBe(
        'completed',
      );
      const reviewed = await env.get();
      const resumeTask = env.store.createTask({
        repositoryId: env.repositoryRecord.id,
        agentId: 'codex-2',
        title: 'Forbidden workflow resume',
        prompt: 'review',
      });
      expect(() =>
        env.manager.start(resumeTask.id, env.store.task(reviewerId)!.sessionId!),
      ).toThrow('snapshot sessions cannot be resumed');
      expect(reviewed.state).toBe('blocked');
      expect(reviewed.stages[1]!.report?.sourceDigest).toBe(
        reviewed.stages[1]!.sourceCandidate!.digest,
      );
      expect(reviewed.stages[2]!.state).toBe('pending');
      const originalResult = env.store.task(reviewerId)!.result;
      env.store.updateTask(reviewerId, { result: 'tampered report' });
      expect(
        (
          await env.send('POST', env.url + '/approve-reviewer-result', {
            version: reviewed.version,
            confirmed: true,
            digest: reviewed.stages[1]!.report!.digest,
          })
        ).statusCode,
      ).toBe(409);
      env.store.updateTask(reviewerId, { result: originalResult });
      expect(env.store.task(reviewerId)?.workspaceId).toBeUndefined();
      expect(
        (
          await env.send('POST', env.url + '/submit-qa', {
            version: reviewed.version,
            confirmed: true,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await env.send('POST', env.url + '/approve-reviewer-result', {
            version: reviewed.version,
            confirmed: true,
            digest: 'a'.repeat(64),
          })
        ).statusCode,
      ).toBe(409);
      await env.post('approve-reviewer-result', { digest: reviewed.stages[1]!.report!.digest });
      expect((await env.get()).stages[2]!.state).toBe('awaiting_approval');
      await env.post('approve-qa', { revision, commandId: 'source' });
      const approvedPlan = env.workspaces.options.commands!.source!;
      env.workspaces.options.commands!.source = ['/bin/echo', 'changed command'];
      const planVersion = (await env.get()).version;
      expect(
        (await env.send('POST', env.url + '/submit-qa', { version: planVersion, confirmed: true }))
          .statusCode,
      ).toBe(409);
      expect(env.store.tasks()).toHaveLength(3);
      env.workspaces.options.commands!.source = approvedPlan;
      const qa = await env.post('submit-qa', {}, 202);
      const qaId = qa.stages[2]!.taskId!;
      await until(
        () => env.store.task(qaId),
        (value) => ['completed', 'failed'].includes(value?.state ?? ''),
        30000,
      );
      expect(env.store.task(qaId)?.state, JSON.stringify(env.store.events(qaId))).toBe('completed');
      expect(env.store.task(qaId)?.result).toContain('QA assertions passed');
      const tested = await env.get();
      expect(tested.state).toBe('blocked');
      await env.post('approve-qa-result', { digest: tested.stages[2]!.report!.digest });
      expect((await env.get()).state).toBe('completed');
      expect((await env.send('GET', '/api/workflows/bundles/audit')).json().retained).toBe(1);
      expect(env.store.sessions()).toHaveLength(2); // QA never starts a model or host verification session.
      expect(await readFile(join(env.repository, 'README.md'), 'utf8')).toBe(
        '# Disposable example\n',
      );
      const workspace = env.store.workspace(env.store.task(task.id)!.workspaceId!)!;
      expect(await readFile(join(workspace.path, 'README.md'), 'utf8')).toBe(
        'Modified by fixture\n',
      );
      const reports = await env.send('GET', env.url + '/results');
      expect(reports.json().map((report: { result: string }) => Boolean(report.result))).toEqual([
        true,
        true,
      ]);
      await env.post('cleanup-artifacts');
      expect((await env.get()).artifactCleanup?.state).toBe('completed');
      expect((await env.send('GET', '/api/workflows/bundles/audit')).json().cleaned).toBe(1);
      await expect(
        readFile(join(reviewed.stages[1]!.runtimeCandidate!.directory, 'README.md')),
      ).rejects.toThrow();
      expect(await readFile(join(workspace.path, 'README.md'), 'utf8')).toBe(
        'Modified by fixture\n',
      );
      expect((await env.send('GET', env.url + '/results')).json()[0].result).toBe(originalResult);
    } finally {
      await env.cleanup();
    }
  },
  120000,
);

it('rejects stale source, tampered runtime, replaced snapshots, lease contention and profile drift without queueing', async () => {
  const env = await workflowFixture();
  try {
    const { workflow, task } = await env.prepare();
    const version = workflow.version;
    const runtime = workflow.stages[1]!.runtimeCandidate!;
    const submit = () =>
      env.send('POST', env.url + '/submit-reviewer', { version, confirmed: true });
    const release = await acquireWorkflowLease(env.store, workflow);
    try {
      expect((await submit()).statusCode).toBe(409);
    } finally {
      await release();
    }
    await writeFile(join(runtime.directory, 'README.md'), 'tampered');
    expect((await submit()).statusCode).toBe(409);
    await writeFile(join(runtime.directory, 'README.md'), 'Modified by fixture\n');
    await rename(runtime.directory, runtime.directory + '.saved');
    await symlink(runtime.directory + '.saved', runtime.directory);
    expect((await submit()).statusCode).toBe(409);
    await rm(runtime.directory);
    await rename(runtime.directory + '.saved', runtime.directory);
    const workspace = env.store.workspace(env.store.task(task.id)!.workspaceId!)!;
    await writeFile(join(workspace.path, 'README.md'), 'changed after approval');
    expect((await submit()).statusCode).toBe(409);
    const profile = env.store.agent('codex-2')!;
    env.store.editAgent(profile.id, profile.revision, { archived: true });
    expect((await submit()).statusCode).toBe(409);
    expect(env.store.queue()).toEqual([]);
    expect(env.store.tasks()).toHaveLength(1);
    expect((await env.get()).version).toBe(version);
  } finally {
    await env.cleanup();
  }
}, 60000);

it('revalidates queued profile authorization at dispatch and forbids generic starts', async () => {
  const env = await workflowFixture();
  try {
    const { workflow } = await env.prepare();
    const release = await acquireWorkflowLease(env.store, workflow);
    let submitted;
    try {
      const snapshot = await validateWorkflowSnapshot(env.store, env.workspaces, workflow);
      submitted = new WorkflowStore(env.store.db).submitReadOnly(
        env.store,
        workflow.id,
        workflow.version,
        'reviewer',
        {
          revision: snapshot.revision,
          sourceDigest: snapshot.sourceDigest,
          runtimeIdentity: snapshot.runtimeIdentity,
          submittedAt: new Date().toISOString(),
        },
        env.auth.view().mode,
      );
    } finally {
      await release();
    }
    const taskId = submitted.stages[1]!.taskId!;
    expect(() => env.manager.start(taskId)).toThrow('already submitted');
    const profile = env.store.agent('codex-2')!;
    env.store.editAgent(profile.id, profile.revision, { ...profile, maximumMode: 'write' });
    env.manager.startQueue();
    await until(
      () => env.store.task(taskId),
      (task) => task?.state === 'failed',
      20000,
    );
    expect((await env.get()).state).toBe('blocked');
    expect(env.store.sessions()).toHaveLength(1);
    expect(env.store.queue()).toEqual([]);
    await env.post('cancel');
    expect((await env.get()).state).toBe('cancelled');
  } finally {
    await env.cleanup();
  }
}, 60000);

native(
  'interrupts a queued downstream stage on restart and never dispatches or resumes it automatically',
  async () => {
    const env = await workflowFixture();
    try {
      const { workflow } = await env.prepare();
      // Submit without allowing the timer-driven queue to claim it.
      const response = await env.send('POST', env.url + '/submit-reviewer', {
        version: workflow.version,
        confirmed: true,
      });
      expect(response.statusCode, response.body).toBe(202);
      const submitted = response.json().workflow;
      const taskId = submitted.stages[1].taskId;
      // Store reopening models crash recovery; no running process is started for this task.
      clearTimeout((env.manager as unknown as { timer: NodeJS.Timeout }).timer);
      const reopened = new Store(join(env.root, 'metadata.sqlite'));
      try {
        expect(reopened.task(taskId)?.state).toBe('interrupted');
        expect(reopened.queue()).toEqual([]);
        const recovered = new WorkflowStore(reopened.db).get(workflow.id)!;
        expect(recovered.state).toBe('blocked');
        expect(recovered.stages[1]!.state).toBe('interrupted');
        expect(recovered.stages[1]!.execution).toBeTruthy();
        expect(
          (
            await env.send('POST', env.url + '/submit-reviewer', {
              version: recovered.version,
              confirmed: true,
            })
          ).statusCode,
        ).toBe(409);
      } finally {
        reopened.close();
      }
    } finally {
      await env.cleanup();
    }
  },
  90000,
);

native(
  'cancels a running SDK Reviewer and blocks QA until a new operator workflow',
  async () => {
    const env = await workflowFixture({ reviewerInstructions: 'WAIT_FIXTURE' });
    try {
      await env.prepare();
      const submitted = await env.post('submit-reviewer', {}, 202);
      const taskId = submitted.stages[1]!.taskId!;
      await until(
        () => env.store.events(taskId),
        (events) => events.some((event) => event.kind === 'thread'),
        30000,
      );
      await env.manager.stop(taskId);
      expect(env.store.task(taskId)?.state).toBe('stopped');
      expect((await env.get()).state).toBe('blocked');
      expect((await env.get()).stages[2]!.state).toBe('pending');
      expect(env.store.queue()).toEqual([]);
    } finally {
      await env.cleanup();
    }
  },
  90000,
);
