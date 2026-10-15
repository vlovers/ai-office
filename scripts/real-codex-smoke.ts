/** Opt-in real ChatGPT-authenticated SDK probe. Never part of deterministic npm test. */
import { Codex, type Thread, type ThreadOptions, type RunStreamedResult } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { MetadataClient, localCli } from './codex-inspect.js';
import { codexOptions, threadOptions } from '../src/server/providers/codex-config.js';
import { validateRepository, changedFiles } from '../src/server/repositories.js';
import { Store } from '../src/server/store.js';
import type { Session, Task } from '../src/shared/types.js';

process.umask(0o077);
if (!process.argv.includes('--run'))
  throw new Error(
    'Pass --run explicitly to consume ChatGPT Codex usage. No API-key fallback is supported.',
  );
const started = performance.now();
const { executable, env } = localCli();
const fingerprint = async () =>
  createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
const beforeCli = await fingerprint();
const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-real-')));
const repository = join(root, 'example');
const evidenceDir = resolve('.ai-office/verification');
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
await mkdir(repository);
execFileSync('/usr/bin/git', ['init', '--quiet', repository], {
  env: {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  },
  stdio: 'ignore',
});
const marker = `AI_OFFICE_REAL_${randomUUID()}`;
const readme = `# Disposable AI Office example\n\nRepository marker: ${marker}\n`;
await writeFile(join(repository, 'README.md'), readme);
const baseline = await changedFiles(repository);
// The SDK has no ignore-user-config/rules options. This fixed local launcher adds only
// those flags to the existing installation. It neither replaces nor changes that CLI.
const launcher = join(root, 'codex-readonly');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(
  launcher,
  `#!/bin/sh\n[ "$1" = exec ] || exit 64\nshift\nexec ${quote(executable)} exec --ignore-user-config --ignore-rules "$@"\n`,
);
await chmod(launcher, 0o700);
let store: Store | undefined;
let metadata: MetadataClient | undefined;
const report: Record<string, unknown> = {
  kind: 'REAL_MODEL_TEST',
  startedAt: new Date().toISOString(),
  sdkVersion: JSON.parse(await readFile('node_modules/@openai/codex-sdk/package.json', 'utf8'))
    .version,
  cliVersion: execFileSync(executable, ['--version'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(),
  authentication: 'unverified',
  apiKeyEnvironmentForwarded: false,
  apiKeyFallback: false,
  credentialFilesOpenedByApplication: false,
  permissionProfile: 'ai-office-review (repository read-only, root deny, network off)',
  repository,
  turns: [],
  errors: [],
};
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout|aborted/i.test(message)) return 'Timed out or cancelled.';
  if (/401|unauthorized|authenticat|not logged/i.test(message))
    return 'Authentication failed (raw diagnostic withheld).';
  if (/403|forbidden/i.test(message)) return 'Access forbidden (raw diagnostic withheld).';
  if (/429|rate.limit|quota/i.test(message))
    return 'Rate/usage limit reached (raw diagnostic withheld).';
  if (/sandbox|operation not permitted|permission denied/i.test(message))
    return 'Sandbox or filesystem permission failure (raw diagnostic withheld).';
  if (/connect|network|dns|resolve|stream disconnected/i.test(message))
    return 'Provider connection failed (raw diagnostic withheld).';
  return 'Probe failed (raw diagnostic withheld).';
};
try {
  metadata = new MetadataClient(executable, env, repository);
  await metadata.initialize();
  const account = await metadata.account();
  report.authentication = account.method;
  assert.equal(
    account.method,
    'chatgpt',
    'Existing ChatGPT authentication required; refusing any API-key fallback.',
  );
  const models = await metadata.models();
  const model = models.find((item) => item.isDefault)?.model;
  assert.ok(model, 'No available default model.');
  report.requestedModel = model;
  await metadata.close();
  metadata = undefined;
  const database = join(evidenceDir, `real-${Date.now()}.sqlite`);
  report.metadataDatabase = database;
  store = new Store(database);
  const registered = store.register(await validateRepository(repository));
  const session = store.createSession(registered.id);
  report.sessionId = session.id;
  for (let index = 0; index < 2; index++) {
    const saved: Session = store.session(session.id)!;
    const task: Task = store.createTask({
      repositoryId: registered.id,
      title: index ? 'Real SDK resume' : 'Real SDK repository read',
      prompt: index
        ? 'Resume without rereading files: repeat the exact repository marker from the previous turn.'
        : 'Read README.md using a read-only tool and return its exact repository marker.',
    });
    store.updateTask(task.id, { state: 'running', sessionId: session.id });
    const client = new Codex(codexOptions(repository, env, launcher));
    const options: ThreadOptions = { ...threadOptions(repository), model };
    const thread: Thread = saved.threadId
      ? client.resumeThread(saved.threadId, options)
      : client.startThread(options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const turnStart = performance.now();
    let completed = false;
    let final = '';
    let commandReadSucceeded = false;
    let failure: string | undefined;
    const eventTypes: Record<string, number> = {};
    const prompt: string = `This is an authorized READ-ONLY integration test in a disposable Git repository. Only inspect README.md in this working directory. Do not write or delete any files, access credentials/auth files, use network tools, change permissions, request escalations, run Git mutations, or use other repositories. No approvals are granted.\n\n${task.prompt}`;
    try {
      const { events }: RunStreamedResult = await thread.runStreamed(prompt, {
        signal: controller.signal,
      });
      for await (const event of events) {
        eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
        if (event.type === 'thread.started') {
          if (saved.threadId) assert.equal(event.thread_id, saved.threadId);
          store.setThread(session.id, event.thread_id);
          report.threadId = event.thread_id;
        }
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error')
          failure = safeError(
            new Error(event.type === 'error' ? event.message : event.error.message),
          );
        if ('item' in event && event.type === 'item.completed') {
          if (event.item.type === 'agent_message') final = event.item.text;
          if (
            event.item.type === 'command_execution' &&
            event.item.exit_code === 0 &&
            event.item.aggregated_output.includes(marker)
          )
            commandReadSucceeded = true;
        }
        // Persist transport metadata only, never raw tool output or diagnostics.
        store.addEvent(task.id, event.type, 'Real SDK event received.');
      }
      assert.ok(completed && !failure, failure ?? 'No completed turn.');
      assert.ok(final.includes(marker), 'Model did not return the repository marker.');
      if (index === 0)
        assert.ok(commandReadSucceeded, 'Model did not successfully read README.md.');
      store.updateTask(task.id, {
        state: 'completed',
        result: final,
        changedFiles: await changedFiles(repository),
      });
      (report.turns as unknown[]).push({
        taskId: task.id,
        resumed: index === 1,
        durationMs: Math.round(performance.now() - turnStart),
        completed,
        markerMatched: true,
        commandReadSucceeded,
        eventTypes,
      });
    } finally {
      clearTimeout(timer);
    }
    // Reopen SQLite and create a new SDK client before resume, so neither JS object carries context.
    store.close();
    store = new Store(database);
    assert.ok(store.session(session.id)?.threadId, 'Thread ID did not survive metadata reopen.');
    assert.equal(store.task(task.id)?.state, 'completed');
  }
  metadata = new MetadataClient(executable, env, repository);
  await metadata.initialize();
  const thread = await metadata.thread(String(report.threadId));
  report.persistedThread = {
    id: thread.id,
    model: thread.model,
    provider: thread.modelProvider,
    cliVersion: thread.cliVersion,
    ephemeral: thread.ephemeral,
    workingDirectoryMatched: thread.cwd === repository,
    nativeTranscriptLocated: Boolean(thread.path),
  };
  assert.equal(thread.model, report.requestedModel);
  assert.equal(thread.cwd, repository);
  assert.equal(thread.ephemeral, false);
  assert.deepEqual(await changedFiles(repository), baseline);
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), readme);
  report.repositoryUnchanged = true;
  report.outcome = 'passed';
} catch (error) {
  (report.errors as string[]).push(safeError(error));
  report.outcome = 'failed';
  process.exitCode = 1;
} finally {
  await metadata?.close();
  store?.close();
  report.durationMs = Math.round(performance.now() - started);
  report.cliEntryUnchanged = beforeCli === (await fingerprint());
  const reportPath = join(evidenceDir, `real-sdk-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}
