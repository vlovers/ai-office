// Test double for the CLI transport, consumed through the REAL installed Codex SDK.
// Never invokes a model, accesses auth, or executes model-generated commands.
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('sandbox')) {
  // Only the inference transport is a fixture. Native policy probes use the installed binary.
  const result = spawnSync(process.execPath, [__NATIVE_CODEX_PATH__, ...args], {
    env: process.env,
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}
const config = args.filter((_, index) => args[index - 1] === '--config');
const filesystem = config.find((arg) => arg.startsWith('permissions.ai-office-review.filesystem='));
if (
  args.includes('--sandbox') ||
  args.includes('--add-dir') ||
  args.includes('--skip-git-repo-check') ||
  config.some(
    (arg) => arg.includes('danger-full-access') || arg.includes('approval_policy="never"'),
  )
)
  throw new Error('Unsafe SDK options');
if (!args.includes('--ignore-user-config') || !args.includes('--ignore-rules'))
  throw new Error('Uncontrolled CLI configuration');
if (
  !filesystem?.includes('":root"="deny"') ||
  !/"\."="(read|write)"/.test(filesystem) ||
  !config.includes('permissions.ai-office-review.network.enabled=false') ||
  !config.includes('approval_policy="on-request"')
)
  throw new Error('Restrictive profile missing');
const repo = args[args.indexOf('--cd') + 1];
if (!repo || !existsSync(repo + '/.git')) throw new Error('Disposable Git worktree required');
if (
  process.env.HOME !== process.env.CODEX_HOME ||
  process.env.AI_OFFICE_TEST_SECRET ||
  process.env.OPENAI_API_KEY
)
  throw new Error('Host environment leaked');
let input = '';
for await (const chunk of process.stdin) input += chunk;
let reviewerResult;
if (input.includes('Review the exact approved source snapshot')) {
  if (!filesystem.includes('"."="read"')) throw new Error('Reviewer must be read-only');
  if (
    readFileSync(repo + '/README.md', 'utf8') !== 'Modified by fixture\n' ||
    readFileSync(repo + '/added.txt', 'utf8') !== 'Created by fixture\n' ||
    existsSync(repo + '/deleted.txt')
  )
    throw new Error('Reviewer received the wrong source snapshot');
  if (!input.includes('deleted.txt') || !input.includes('added.txt'))
    throw new Error('Approved changes missing from Reviewer context');
  reviewerResult =
    'Verified approved snapshot: README modified, added.txt added, deleted.txt deleted. <script>window.workflowInjected=true</script>';
}
if (input.includes('WRITE_FIXTURE')) {
  if (!filesystem.includes('"."="write"')) throw new Error('Write profile missing');
  writeFileSync(repo + '/README.md', 'Modified by fixture\n');
  writeFileSync(repo + '/added.txt', 'Created by fixture\n');
  unlinkSync(repo + '/deleted.txt');
}
if (input.includes('CORRECT_FIXTURE')) writeFileSync(repo + '/README.md', 'Corrected by fixture\n');
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const savedThread = args.find((arg) => /^00000000-0000-4000-8000-[a-f0-9]{12}$/.test(arg));
const threadId =
  savedThread ??
  `00000000-0000-4000-8000-${createHash('sha256').update(repo).digest('hex').slice(0, 12)}`;
send({ type: 'thread.started', thread_id: threadId });
send({ type: 'turn.started' });
if (input.includes('AUTH_FIXTURE')) {
  send({
    type: 'turn.failed',
    error: { message: '401 unauthorized: expired login AUTH_SECRET_SYNTHETIC' },
  });
  process.exit(1);
}
if (input.includes('FAIL_FIXTURE')) {
  send({ type: 'turn.failed', error: { message: 'Simulated provider failure' } });
  process.exit(1);
}
if (input.includes('EXIT_FIXTURE')) process.exit(7);
if (input.includes('WAIT_FIXTURE')) {
  // Ignore graceful termination to exercise supervisor process-group escalation.
  process.on('SIGTERM', () => {});
  setInterval(
    () =>
      send({
        type: 'item.updated',
        item: { id: 'wait', type: 'reasoning', text: 'Waiting for Stop…' },
      }),
    100,
  );
} else {
  send({
    type: 'item.completed',
    item: {
      id: 'commentary',
      type: 'agent_message',
      text: 'Interim commentary: I will inspect the repository.',
    },
  });
  send({
    type: 'item.started',
    item: { id: 'review', type: 'reasoning', text: 'Inspecting the disposable repository.' },
  });
  const resumed = args.includes('resume');
  send({
    type: 'item.completed',
    item: {
      id: 'result',
      type: 'agent_message',
      text: resumed
        ? 'Resumed the saved review thread.'
        : (reviewerResult ??
          'Reviewed the disposable repository. README.md is present. No files were modified.'),
    },
  });
  send({
    type: 'turn.completed',
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 12,
      reasoning_output_tokens: 0,
    },
  });
}
