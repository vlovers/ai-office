import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpath, writeFile, readFile } from 'node:fs/promises';
import { sandbox, until } from './helpers.js';
import { TaskManager } from '../src/server/manager.js';
import { Store } from '../src/server/store.js';
import { Workspaces } from '../src/server/workspaces.js';
import { validateRepository } from '../src/server/repositories.js';
import { createApp } from '../src/server/app.js';
import { diffLines } from '../src/shared/diff.js';
import type { WorkspaceReview, ReviewRecord, ReviewComment } from '../src/shared/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const env = await sandbox();
  cleanup.push(env.cleanup);
  await writeFile(join(env.repository, 'deleted.txt'), 'deleted\n');
  execFileSync('/usr/bin/git', ['-C', env.repository, 'add', '.']);
  execFileSync('/usr/bin/git', [
    '-C',
    env.repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'Fixture',
  ]);
  const root = await realpath(env.root);
  const service = new Workspaces({ authorizedRoot: root, workspaceRoot: join(root, 'worktrees') });
  const manager = new TaskManager(
    env.store,
    env.providers,
    env.auth,
    undefined,
    undefined,
    service,
  );
  cleanup.push(() => manager.shutdown());
  const repo = env.store.register(await validateRepository(env.repository));
  const task = env.store.createTask({
    repositoryId: repo.id,
    title: 'Write',
    prompt: 'WRITE_FIXTURE',
    executionMode: 'write',
  });
  manager.start(task.id, undefined, true);
  await until(
    () => env.store.task(task.id),
    (t) => t?.state === 'completed',
  );
  const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
  const workspace = review.workspace;
  const now = new Date().toISOString();
  const comments: ReviewComment[] = [
    {
      id: randomUUID(),
      body: 'CORRECT_FIXTURE: improve README',
      path: 'README.md',
      anchor: { side: 'new', line: 1 },
      createdAt: now,
      updatedAt: now,
    },
  ];
  async function save(items = comments, version = 0, revision = review.revision!) {
    return (await manager.reviewOperation(task.id, 'feedback', undefined, revision, {
      revision,
      version,
      comments: items,
    })) as ReviewRecord;
  }
  async function request(version = 1, revision = review.revision!) {
    return (await manager.reviewOperation(task.id, 'request-changes', undefined, revision, {
      revision,
      version,
      comments: [],
    })) as ReviewRecord;
  }
  return { ...env, manager, service, repo, task, review, workspace, save, request, comments };
}
it('parses added/deleted/context lines without anchoring headers and treats HTML as text', () => {
  expect(
    diffLines('--- a/x\n+++ b/x\n@@ -2,2 +3,2 @@\n-<script>\n+const x\n end\n+not a hunk'),
  ).toEqual([
    { text: '--- a/x', kind: 'meta' },
    { text: '+++ b/x', kind: 'meta' },
    { text: '@@ -2,2 +3,2 @@', kind: 'hunk' },
    { text: '-<script>', kind: 'delete', old: 2 },
    { text: '+const x', kind: 'add', new: 3 },
    { text: ' end', kind: 'context', old: 3, new: 4 },
    { text: '+not a hunk', kind: 'meta' },
  ]);
});
it('persists draft edits, rejects invalid anchors and optimistic conflicts, and preserves history across restart', async () => {
  const env = await fixture();
  const saved = await env.save();
  expect(saved.comments[0]?.anchor).toEqual({ side: 'new', line: 1 });
  await expect(env.save()).rejects.toThrow('Feedback changed');
  await expect(env.save([{ ...env.comments[0]!, path: '../escape' }], 1)).rejects.toThrow(
    'not in this revision',
  );
  await expect(
    env.save([{ ...env.comments[0]!, anchor: { side: 'new', line: 999 } }], 1),
  ).rejects.toThrow('anchor');
  await env.save([{ ...env.comments[0]!, body: 'Edited' }], 1);
  await env.manager.shutdown();
  env.store.close();
  const reopened = new Store(join(env.root, 'metadata.sqlite'));
  try {
    expect(reopened.reviewRecord(env.workspace.id, env.review.revision!)?.comments[0]?.body).toBe(
      'Edited',
    );
  } finally {
    reopened.close();
  }
});
it('resumes exactly one existing SDK thread, generates a new revision, preserves submitted feedback and allows rejection', async () => {
  const env = await fixture();
  const pinned = env.store.sessionConfiguration(env.store.task(env.task.id)!.sessionId!);
  const profile = env.store.requireAgent(env.task.agentId);
  env.store.editAgent(profile.id, profile.revision, {
    ...profile,
    maximumMode: 'read-only',
    instructions: 'Different instructions',
    model: 'unavailable-model',
  });
  env.store.editAgent(profile.id, profile.revision + 1, { archived: true });
  await env.save();
  const submitted = await env.request();
  expect((await env.request()).continuationTaskId).toBe(submitted.continuationTaskId);
  await until(
    () => env.store.task(submitted.continuationTaskId!),
    (t) => t?.state === 'completed',
  );
  const next = env.store.task(submitted.continuationTaskId!)!;
  expect(next.sessionId).toBe(env.store.task(env.task.id)?.sessionId);
  expect(env.store.sessions()).toHaveLength(1);
  expect(env.store.taskConfiguration(next.id)).toEqual(pinned);
  expect(await readFile(join(env.workspace.path, 'README.md'), 'utf8')).toContain(
    'Corrected by fixture',
  );
  const updated = (await env.manager.reviewOperation(next.id, 'review')) as WorkspaceReview;
  expect(updated.record?.number).toBe(2);
  expect(updated.revision).not.toBe(env.review.revision);
  expect(updated.record?.comments).toEqual([]);
  const history = env.manager.reviewHistory(next.id);
  expect(history[1]?.comments[0]?.body).toContain('CORRECT_FIXTURE');
  expect(history[1]?.continuation?.state).toBe('completed');
  await expect(env.save([], 1)).rejects.toThrow('immutable');
  await env.manager.reviewOperation(next.id, 'reject', undefined, updated.revision);
  expect(env.manager.reviewHistory(next.id)).toHaveLength(2);
  expect(env.store.workspace(env.workspace.id)?.decision).toBe('rejected');
  expect(await readFile(join(env.repository, 'README.md'), 'utf8')).toBe('# Disposable example\n');
});
it('rejects stale request submissions and changes after confirmation before execution', async () => {
  const env = await fixture();
  await env.save();
  await writeFile(join(env.workspace.path, 'README.md'), 'external edit\n');
  await expect(env.request()).rejects.toThrow('changed');
  expect(env.store.queue()).toHaveLength(0);
  const fresh = (await env.manager.reviewOperation(env.task.id, 'review')) as WorkspaceReview;
  await env.save(env.comments, 0, fresh.revision);
  const submitted = await env.request(1, fresh.revision);
  await writeFile(join(env.workspace.path, 'README.md'), 'changed after confirmation\n');
  await until(
    () => env.store.task(submitted.continuationTaskId!),
    (t) => t?.state === 'failed',
  );
  expect(env.store.task(submitted.continuationTaskId!)?.error).toContain('changed');
  expect(await readFile(join(env.workspace.path, 'README.md'), 'utf8')).toBe(
    'changed after confirmation\n',
  );
});
it('rolls back queue/history/task together and serializes concurrent submissions', async () => {
  const env = await fixture();
  await env.save();
  env.store.db.exec(
    "CREATE TRIGGER fail_review_queue BEFORE INSERT ON task_queue BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await expect(env.request()).rejects.toThrow('synthetic failure');
  expect(env.store.tasks()).toHaveLength(1);
  expect(
    env.store.reviewRecord(env.workspace.id, env.review.revision!)?.submittedAt,
  ).toBeUndefined();
  env.store.db.exec('DROP TRIGGER fail_review_queue');
  const attempts = await Promise.allSettled([env.request(), env.request()]);
  expect(attempts.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0);
  expect(env.store.tasks()).toHaveLength(2);
  const submitted = await env.request();
  await until(
    () => env.store.task(submitted.continuationTaskId!),
    (t) => t?.state === 'completed',
  );
});
it('fails closed for session replacement and advanced workspace HEAD', async () => {
  const env = await fixture();
  await env.save();
  env.store.setThread(env.review.record!.sessionId!, 'replacement-thread');
  await expect(env.request()).rejects.toThrow('identity changed');
  env.store.setThread(env.review.record!.sessionId!, env.review.record!.threadId!);
  execFileSync('/usr/bin/git', [
    '-C',
    env.workspace.path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--allow-empty',
    '-qm',
    'advanced',
  ]);
  const fresh = (await env.manager.reviewOperation(env.task.id, 'review')) as WorkspaceReview;
  await env.save(env.comments, 0, fresh.revision);
  await expect(env.request(1, fresh.revision)).rejects.toThrow('HEAD advanced');
});
it('bounds file patches while retaining sensitive, binary and oversized findings', async () => {
  const env = await fixture();
  await writeFile(join(env.workspace.path, '.env'), 'SYNTHETIC_SECRET');
  await writeFile(join(env.workspace.path, 'binary.dat'), Buffer.from([0, 1, 2]));
  await writeFile(join(env.workspace.path, 'huge.txt'), 'x'.repeat(300000));
  await writeFile(
    join(env.workspace.path, '<img onerror=alert(1)>.tsx'),
    'const text = "<script>";\n',
  );
  const review = (await env.manager.reviewOperation(env.task.id, 'review')) as WorkspaceReview;
  expect(review.files.find((file) => file.path === '.env')?.availability).toBe('withheld');
  expect(review.files.find((file) => file.path === 'binary.dat')?.availability).toBe('binary');
  expect(review.files.find((file) => file.path === 'huge.txt')?.patch).toBeUndefined();
  expect(JSON.stringify(review)).not.toContain('SYNTHETIC_SECRET');
  expect(review.files.find((file) => file.path.startsWith('<img'))?.patch).toContain('<script>');
});
it('requires strict explicit confirmation over HTTP and rejects malformed feedback', async () => {
  const env = await fixture();
  const app = await createApp(env.manager);
  cleanup.push(() => app.close());
  const headers = { host: '127.0.0.1:4310', 'content-type': 'application/json' };
  const url = `/api/tasks/${env.task.id}/review/request-changes`;
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { revision: env.review.revision, version: 0 },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { revision: env.review.revision, version: 0, confirmed: true },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${env.task.id}/review/feedback`,
        headers,
        payload: {
          revision: env.review.revision,
          version: 0,
          comments: [{ ...env.comments[0], path: '../escape' }],
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(env.store.tasks()).toHaveLength(1);
});

it('rechecks revision after asynchronous SDK authentication preparation before any write turn', async () => {
  const env = await fixture();
  await env.save();
  const original = env.provider.resumeSession.bind(env.provider);
  let executions = 0;
  const execute = env.provider.executeTask.bind(env.provider);
  env.provider.executeTask = async (...args) => {
    executions++;
    return execute(...args);
  };
  env.provider.resumeSession = async (...args) => {
    const session = await original(...args);
    await writeFile(join(env.workspace.path, 'README.md'), 'external edit during auth\n');
    return session;
  };
  const submitted = await env.request();
  await until(
    () => env.store.task(submitted.continuationTaskId!),
    (t) => t?.state === 'failed',
  );
  expect(executions).toBe(0);
  expect(env.store.task(submitted.continuationTaskId!)?.error).toContain('changed');
  expect(env.store.sessions()).toHaveLength(1);
});

it('preserves interrupted feedback history and Keep semantics after stopping a continuation', async () => {
  const env = await fixture();
  await env.save([{ ...env.comments[0]!, body: 'WAIT_FIXTURE' }]);
  const submitted = await env.request();
  await until(
    () => env.store.events(submitted.continuationTaskId!),
    (events) => events.some((event) => event.message.includes('Waiting for Stop')),
  );
  await env.manager.stop(submitted.continuationTaskId!);
  expect(env.manager.reviewHistory(env.task.id)[0]?.continuation?.state).toBe('stopped');
  const fresh = (await env.manager.reviewOperation(
    submitted.continuationTaskId!,
    'review',
  )) as WorkspaceReview;
  expect(fresh.revision).not.toBe(env.review.revision);
  await env.manager.reviewOperation(
    submitted.continuationTaskId!,
    'keep',
    undefined,
    fresh.revision,
  );
  expect(await readFile(join(env.workspace.path, 'README.md'), 'utf8')).toBe(
    'Modified by fixture\n',
  );
  expect(
    env.manager.reviewHistory(env.task.id).find((item) => item.revision === env.review.revision)
      ?.comments[0]?.body,
  ).toBe('WAIT_FIXTURE');
  await expect(
    env.manager.reviewOperation(
      submitted.continuationTaskId!,
      'request-changes',
      undefined,
      fresh.revision,
      { revision: fresh.revision!, version: 0, comments: [] },
    ),
  ).rejects.toThrow();
});

it('reloads saved session identity after asynchronous authentication and refuses replacement', async () => {
  const env = await fixture();
  await env.save();
  const original = env.provider.resumeSession.bind(env.provider);
  let executions = 0;
  const execute = env.provider.executeTask.bind(env.provider);
  env.provider.executeTask = async (...args) => {
    executions++;
    return execute(...args);
  };
  env.provider.resumeSession = async (...args) => {
    const session = await original(...args);
    env.store.setThread(env.review.record!.sessionId!, 'replaced-during-auth');
    return session;
  };
  const submitted = await env.request();
  await until(
    () => env.store.task(submitted.continuationTaskId!),
    (t) => t?.state === 'failed',
  );
  expect(executions).toBe(0);
  expect(env.store.task(submitted.continuationTaskId!)?.error).toContain('identity changed');
  expect(env.store.sessions()).toHaveLength(1);
});

it('advances canceled queued feedback atomically and permits only a freshly confirmed retry', async () => {
  const env = await fixture();
  await env.save();
  const canceled = await env.request();
  env.store.db.exec(
    "CREATE TRIGGER fail_cancel BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'synthetic cancel failure'); END",
  );
  await expect(env.manager.stop(canceled.continuationTaskId!)).rejects.toThrow(
    'synthetic cancel failure',
  );
  expect(env.store.task(canceled.continuationTaskId!)?.state).toBe('queued');
  expect(env.store.queue().some((entry) => entry.taskId === canceled.continuationTaskId)).toBe(
    true,
  );
  env.store.db.exec('DROP TRIGGER fail_cancel');
  await env.manager.stop(canceled.continuationTaskId!);
  expect(env.store.task(canceled.continuationTaskId!)?.state).toBe('stopped');
  expect(env.store.task(canceled.continuationTaskId!)?.sessionId).toBeNull();
  expect((await env.request()).continuationTaskId).toBe(canceled.continuationTaskId);
  expect(env.store.queue()).toEqual([]);
  const fresh = (await env.manager.reviewOperation(
    canceled.continuationTaskId!,
    'review',
  )) as WorkspaceReview;
  expect(fresh.revision).not.toBe(env.review.revision);
  expect(fresh.record?.number).toBe(2);
  expect(fresh.record?.sessionId).toBe(env.review.record?.sessionId);
  expect(fresh.record?.threadId).toBe(env.review.record?.threadId);
  await env.save(env.comments, 0, fresh.revision);
  const retry = await env.request(1, fresh.revision);
  expect(retry.continuationTaskId).not.toBe(canceled.continuationTaskId);
  await until(
    () => env.store.task(retry.continuationTaskId!),
    (task) => task?.state === 'completed',
  );
  expect(env.store.sessions()).toHaveLength(1);
  expect(await readFile(join(env.workspace.path, 'README.md'), 'utf8')).toBe(
    'Corrected by fixture\n',
  );
});
